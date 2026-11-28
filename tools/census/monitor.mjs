#!/usr/bin/env node
// Keep-alive + badge-continuity monitor (runs every 10 min from .github/workflows/monitor.yml; also usable by hand).
// 1. Wakes the API (a free Render service sleeps after 15 idle minutes) and the site, with retries.
// 2. Reads GET /api/status: API, census freshness, the three PayOnce badges (official check), registry, nodes.
// 3. Prints a table, writes the step summary, appends a line to status/history.jsonl ONLY when the state changed (so the
//    history is a list of incidents, not 144 lines a day), exits 1 when a required check fails (GitHub then emails the owner).
//   node tools/census/monitor.mjs [--api URL] [--site URL] [--history status/history.jsonl] [--no-history]
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const API = arg('--api', 'https://payonce-api-n98a.onrender.com');
const SITE = arg('--site', 'https://payonce-tau.vercel.app');
const HISTORY = arg('--history', 'status/history.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(60_000) }); const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch { /* html */ } if (r.ok) return { status: r.status, body: b }; last = `HTTP ${r.status}`; }
    catch (e) { last = String(e?.message ?? e).slice(0, 80); }
    await sleep(10_000 * (i + 1));
  }
  return { status: 0, error: last };
}
const [site, st] = await Promise.all([get(`${SITE}/app`, 3), get(`${API}/api/status`)]);
const checks = st.body?.checks ?? [];
const rows = [{ id: 'site', required: true, ok: site.status === 200, detail: `HTTP ${site.status || site.error}` }, ...(st.status ? checks : [{ id: 'api', required: true, ok: false, detail: `/api/status unreachable: ${st.error}` }])];
const ok = rows.filter((r) => r.required).every((r) => r.ok);
const degraded = rows.some((r) => !r.required && !r.ok);
const badges = st.body?.badges ?? [];
for (const r of rows) console.log(`${r.ok ? 'OK  ' : r.required ? 'FAIL' : 'WARN'}  ${r.id.padEnd(13)} ${r.detail ?? ''}`);
for (const b of badges) console.log(`      badge ${b.token_id} (${b.role}): ${b.valid === true ? 'valid' : `NOT VALID ${b.issues.join(',')}`}`);
const state = ok ? (degraded ? 'degraded' : 'ok') : 'down';
console.log(`state=${state}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### PayOnce status: ${state}\n\n| check | result | detail |\n|---|---|---|\n${rows.map((r) => `| ${r.id} | ${r.ok ? 'ok' : r.required ? '**FAIL**' : 'warn'} | ${String(r.detail ?? '').replace(/\|/g, '/')} |`).join('\n')}\n\n${badges.map((b) => `- badge ${b.token_id} (${b.role}): ${b.valid === true ? 'valid' : '**NOT VALID** ' + b.issues.join(',')}`).join('\n')}\n`);
if (!process.argv.includes('--no-history')) {
  let prev = null;
  if (existsSync(HISTORY)) { const lines = readFileSync(HISTORY, 'utf8').trim().split('\n').filter(Boolean); if (lines.length) { try { prev = JSON.parse(lines[lines.length - 1]); } catch { /* ignore */ } } }
  const failing = rows.filter((r) => !r.ok).map((r) => r.id).sort();
  const sig = `${state}|${failing.join(',')}|${badges.map((b) => `${b.token_id}:${b.valid}`).join(',')}`;
  if (!prev || prev.sig !== sig) {
    mkdirSync(dirname(HISTORY), { recursive: true });
    appendFileSync(HISTORY, JSON.stringify({ at: new Date().toISOString(), state, failing, badges: badges.map((b) => ({ id: b.token_id, valid: b.valid })), sig }) + '\n');
    console.log('state changed: history line appended');
  }
}
process.exit(ok ? 0 : 1);
