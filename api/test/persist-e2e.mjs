// PayOnce API server — Postgres persistence acceptance test (FULL E2E).
// Creates a fresh CCD payable, pays it for real on testnet, verifies the
// receipt, RESTARTS the server process, and verifies the receipt + stats +
// payment_tx + job + counters SURVIVE the restart unchanged. Also verifies
// the seed receipts (1000-1004) and the reconciled payable 1005 receipt.
//
// This test SPENDS testnet CCD (one register + one pay_ccd, dust fees) and
// leaves a real paid payable on the registry — that is the point.
// Run explicitly:  DATABASE_URL=<render-db-external-url> node test/persist-e2e.mjs
// (NOT part of `npm test`.) Requires the wallet env (same file the backend
// uses) + network access to the Render Postgres DB + testnet.
// The server is spawned as a REAL child process (node src/server.mjs) so
// the restart is a genuine process restart, not a module reload.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PERSIST_E2E_PORT ?? 17404);
const BASE = `http://127.0.0.1:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (!DATABASE_URL) {
  console.error('[persist-e2e] FAIL: DATABASE_URL is not set. Point it at the REAL Render Postgres DB (external connection string) and re-run.');
  process.exit(2);
}
if (!/^postgres(ql)?:\/\//.test(DATABASE_URL)) {
  console.error('[persist-e2e] FAIL: DATABASE_URL does not look like a Postgres URL.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function log(step, detail) {
  console.log(`[persist-e2e] ${step}: ${detail}`);
  results.push({ step, detail });
}
function fail(msg) {
  console.error(`[persist-e2e] FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, json, text };
}

let child = null;
async function startServer() {
  child = spawn('node', ['src/server.mjs'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL, PAYONCE_API_PORT: String(PORT), PAYONCE_API_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim() && !l.includes('DATABASE_URL')) console.log(`[server] ${l}`); });
  child.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim() && !l.includes('DATABASE_URL')) console.log(`[server:err] ${l}`); });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const r = await req('GET', '/api/config');
      if (r.status === 200) { log('server up', `:${PORT} (registry <${r.json.registry.index},${r.json.registry.subindex}>)`); return; }
    } catch { /* not up yet */ }
    if (child.exitCode != null) fail(`server process exited early (code ${child.exitCode})`);
    await sleep(2000);
  }
  fail('server did not come up in 180s');
}

async function stopServer(signal = 'SIGTERM') {
  if (!child) return;
  const c = child;
  child = null;
  c.kill(signal);
  const deadline = Date.now() + 30_000;
  while (c.exitCode == null && Date.now() < deadline) await sleep(500);
  if (c.exitCode == null) { c.kill('SIGKILL'); fail('server did not stop on SIGTERM'); }
  log('server stopped', `exit code ${c.exitCode} (${signal})`);
}

async function waitJob(jobId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let job = null;
  while (Date.now() < deadline) {
    const r = await req('GET', `/api/jobs/${jobId}`);
    job = r.json;
    if (job?.state && job.state !== 'running') break;
    await sleep(3000);
  }
  return job;
}

async function main() {
  // ---- 0. Baseline (before the fresh pay) ----
  await startServer();
  const health0 = await req('GET', '/api/health');
  if (health0.status !== 200) fail(`health: HTTP ${health0.status}`);
  log('health baseline', `new_invoices_left=${health0.json.budget.new_invoices_left_this_hour} attack_sends_left=${health0.json.budget.attack_sends_left_this_hour}`);
  if (health0.json.budget.new_invoices_left_this_hour < 1) fail('hourly new-invoice budget is exhausted — re-run next hour (the budget itself is the persistence proof, but no fresh payable can be created now)');
  const stats0 = await req('GET', '/api/stats');
  log('stats baseline', `payables=${stats0.json.payables_total} paid=${stats0.json.paid_total} refused=${stats0.json.refused_on_chain_since_deploy} verifier_runs_at=${stats0.json.last_verifier_run_at}`);
  const seed1002 = await req('GET', '/api/receipts/1002');
  if (seed1002.status !== 200) fail(`seed receipt 1002: HTTP ${seed1002.status}`);
  log('seed receipt 1002', `payment_tx ${seed1002.json.txs[0].tx_hash.slice(0, 8)}…`);
  const r1005 = await req('GET', '/api/receipts/1005');
  if (r1005.status !== 200) fail(`reconciled receipt 1005: HTTP ${r1005.status} — the reconcile did not rebuild it`);
  if (r1005.json.verifier?.passed !== 10) fail(`receipt 1005 verifier ${r1005.json.verifier?.passed}/${r1005.json.verifier?.total} (expected 10/10)`);
  log('receipt 1005 (reconciled)', `verifier 10/10, payment_tx ${r1005.json.txs[0].tx_hash.slice(0, 8)}…, source ${r1005.json.payment_tx_source}`);

  // ---- 1. Fresh CCD payable ----
  const created = await req('POST', '/api/payables', { asset: 'ccd' });
  if (created.status !== 201) fail(`create CCD payable: HTTP ${created.status} ${JSON.stringify(created.json)}`);
  const id = created.json.payable_id;
  log('create CCD payable', `#${id} register ${created.json.tx_hash.slice(0, 8)}… fee ${created.json.fee_testnet_ccd} CCD`);
  const doc = await req('GET', `/api/payables/${id}/document`);
  if (doc.status !== 200) fail(`document for #${id}: HTTP ${doc.status}`);
  const pay = await req('POST', `/api/payables/${id}/pay`, { rail: 'ccd' });
  if (pay.status !== 200) fail(`pay #${id}: HTTP ${pay.status} ${JSON.stringify(pay.json)}`);
  const job = await waitJob(pay.json.job_id);
  if (job.state !== 'succeeded' || job.outcome !== 'paid') fail(`CCD job: state=${job.state} outcome=${job.outcome}`);
  const payTx = job.steps.find((s) => s.step === 'submit')?.txHash;
  const payFee = job.steps.find((s) => s.step === 'wait_finality')?.detail ?? '';
  log('pay CCD succeeded', `pay tx ${payTx} (${payFee})`);
  const receipt = await req('GET', `/api/receipts/${id}`);
  if (receipt.status !== 200 || receipt.json.verifier?.passed !== 10) fail(`receipt #${id}: ${JSON.stringify(receipt.json)}`);
  log('receipt before restart', `verifier ${receipt.json.verifier.passed}/${receipt.json.verifier.total}, payment_tx ${receipt.json.txs[0].tx_hash.slice(0, 8)}…, source ${receipt.json.payment_tx_source}`);
  const payableBefore = await req('GET', `/api/payables/${id}`);
  const statsBefore = await req('GET', '/api/stats');
  const healthBefore = await req('GET', '/api/health');

  // ---- 2. RESTART the server process ----
  await stopServer('SIGTERM');
  await startServer();

  // ---- 3. Everything must survive unchanged ----
  const receiptAfter = await req('GET', `/api/receipts/${id}`);
  if (receiptAfter.status !== 200) fail(`receipt #${id} AFTER restart: HTTP ${receiptAfter.status} — THE DEFECT IS BACK`);
  if (JSON.stringify(receiptAfter.json.txs) !== JSON.stringify(receipt.json.txs)) fail('receipt txs changed across restart');
  if (receiptAfter.json.verifier?.passed !== 10) fail(`receipt #${id} verifier after restart: ${receiptAfter.json.verifier?.passed}/10`);
  log('receipt survives restart', `identical txs, verifier 10/10, payment_tx ${receiptAfter.json.txs[0].tx_hash.slice(0, 8)}…`);
  const payableAfter = await req('GET', `/api/payables/${id}`);
  if (payableAfter.json?.status?.payment_tx !== payTx) fail(`payable #${id} payment_tx changed across restart (was ${payTx}, now ${payableAfter.json?.status?.payment_tx})`);
  log('payment_tx survives restart', `${payableAfter.json.status.payment_tx.slice(0, 8)}… (source ${payableAfter.json.status.payment_tx_source})`);
  const jobAfter = await req('GET', `/api/jobs/${pay.json.job_id}`);
  if (jobAfter.status !== 200 || jobAfter.json.state !== 'succeeded') fail(`job ${pay.json.job_id} after restart: HTTP ${jobAfter.status} state=${jobAfter.json?.state}`);
  log('job survives restart', `${pay.json.job_id} state=${jobAfter.json.state} outcome=${jobAfter.json.outcome}`);
  const statsAfter = await req('GET', '/api/stats');
  if (statsAfter.json.payables_total !== statsBefore.json.payables_total) fail(`stats payables_total changed across restart (${statsBefore.json.payables_total} -> ${statsAfter.json.payables_total})`);
  if (statsAfter.json.paid_total !== statsBefore.json.paid_total) fail(`stats paid_total changed across restart (${statsBefore.json.paid_total} -> ${statsAfter.json.paid_total})`);
  if (statsAfter.json.refused_on_chain_since_deploy !== statsBefore.json.refused_on_chain_since_deploy) fail('stats refused count changed across restart');
  log('stats survive restart', `payables=${statsAfter.json.payables_total} paid=${statsAfter.json.paid_total} refused=${statsAfter.json.refused_on_chain_since_deploy}`);
  const r1005b = await req('GET', '/api/receipts/1005');
  if (r1005b.status !== 200 || r1005b.json.verifier?.passed !== 10) fail('receipt 1005 did not survive the restart');
  log('receipt 1005 survives restart', 'verifier 10/10');
  const seed1002b = await req('GET', '/api/receipts/1002');
  if (seed1002b.status !== 200) fail('seed receipt 1002 did not survive the restart');
  log('seed receipt 1002 survives restart', `payment_tx ${seed1002b.json.txs[0].tx_hash.slice(0, 8)}…`);
  const healthAfter = await req('GET', '/api/health');
  if (healthAfter.json.budget.new_invoices_left_this_hour !== healthBefore.json.budget.new_invoices_left_this_hour) {
    fail(`hourly budget changed across restart (${healthBefore.json.budget.new_invoices_left_this_hour} -> ${healthAfter.json.budget.new_invoices_left_this_hour})`);
  }
  log('hourly budget survives restart', `new_invoices_left=${healthAfter.json.budget.new_invoices_left_this_hour}`);

  await stopServer('SIGTERM');
  console.log(`\n[persist-e2e] ALL PERSISTENCE CHECKS PASSED — payable #${id} (CCD, paid, pay tx ${payTx}) survives a real process restart; seed + 1005 receipts, stats, job, counters and budget all intact.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[persist-e2e] ERROR:', e.message);
  if (child) { try { child.kill('SIGKILL'); } catch {} }
  process.exit(1);
});
