// TEMPORARY diagnostic probe: Postgres reachability from inside Render.
// Prints hostnames + ok/fail + error messages only — never connection strings.
import dns from 'node:dns/promises';
import net from 'node:net';
import pg from 'pg';

const OLD_URL = process.env.OLD_DB_URL ?? '';
const NEW_URL = process.env.DATABASE_URL ?? '';

function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }
function withExternalHost(u) {
  try {
    const url = new URL(u);
    if (!url.hostname.includes('.')) url.hostname = `${url.hostname}.frankfurt-postgres.render.com`;
    return url.toString();
  } catch { return ''; }
}

async function dnsProbe(host) {
  try {
    const r = await dns.lookup(host);
    console.log(`[probe] DNS ${host} -> ${r.address} OK`);
  } catch (e) { console.log(`[probe] DNS ${host} -> FAIL ${e.code ?? e.message}`); }
}

async function tcpProbe(host, port = 5432) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 8000 });
    s.once('connect', () => { console.log(`[probe] TCP ${host}:${port} -> OK`); s.destroy(); resolve(); });
    s.once('timeout', () => { console.log(`[probe] TCP ${host}:${port} -> TIMEOUT`); s.destroy(); resolve(); });
    s.once('error', (e) => { console.log(`[probe] TCP ${host}:${port} -> FAIL ${e.code ?? e.message}`); resolve(); });
  });
}

async function pgProbe(label, connStr, ssl) {
  const pool = new pg.Pool({ connectionString: connStr, ssl, max: 1, connectionTimeoutMillis: 8000 });
  try {
    await pool.query('SELECT 1 AS one');
    console.log(`[probe] PG ${label} -> OK`);
  } catch (e) {
    console.log(`[probe] PG ${label} -> FAIL ${e.code ?? ''} ${e.message}`);
  } finally { await pool.end().catch(() => {}); }
}

const oldInternalHost = hostOf(OLD_URL);
const oldExternalHost = hostOf(withExternalHost(OLD_URL));
const newInternalHost = hostOf(NEW_URL);
const newExternalHost = hostOf(withExternalHost(NEW_URL));
console.log(`[probe] hosts: old-internal=${oldInternalHost} old-external=${oldExternalHost} new-internal=${newInternalHost} new-external=${newExternalHost}`);

for (const h of [oldInternalHost, oldExternalHost, newInternalHost, newExternalHost]) {
  if (h) await dnsProbe(h);
}
for (const h of [oldExternalHost, newExternalHost]) {
  if (h) await tcpProbe(h);
}
if (NEW_URL) await pgProbe('new-internal (no TLS)', NEW_URL, false);
if (NEW_URL) await pgProbe('new-external (TLS)', withExternalHost(NEW_URL), { rejectUnauthorized: false });
if (OLD_URL) await pgProbe('old-external (TLS)', withExternalHost(OLD_URL), { rejectUnauthorized: false });
console.log('[probe] DONE');
