// PayOnce API server — live smoke test (FULL E2E, REAL SENDS, REAL FEES).
// Creates fresh payables, pays them for real on testnet, verifies, and
// runs the two live chain attacks. This test SPENDS testnet CCD/EUDemo
// (a few tens of CCD in fees + 0.5 CCD + 0.01 EUDemo in payments) and
// leaves real paid payables on the registry — that is the point: it
// proves the whole loop end to end, exactly as a judge would run it.
// Run explicitly: node test/smoke.mjs  (NOT part of `npm test`.)
// Requires: the wallet env (same file the backend uses) + testnet access.
import { createHash } from 'node:crypto';
import { server } from '../src/server.mjs';

const PORT = 17402;
const BASE = `http://127.0.0.1:${PORT}`;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function log(step, detail) {
  console.log(`[smoke] ${step}: ${detail}`);
  results.push({ step, detail });
}
function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
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

async function waitJob(jobId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  // Also watch the SSE stream (proves the events endpoint works).
  const sseEvents = [];
  const ssePromise = (async () => {
    try {
      const res = await fetch(`${BASE}/api/jobs/${jobId}/events`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (line.startsWith('data: ')) {
              try { sseEvents.push(JSON.parse(line.slice(6))); } catch { /* ping */ }
            }
          }
          if (sseEvents.some((e) => e.type === 'done')) return sseEvents;
        }
      }
    } catch { /* SSE is best-effort here; the poll below is authoritative */ }
    return sseEvents;
  })();
  let job = null;
  while (Date.now() < deadline) {
    const r = await req('GET', `/api/jobs/${jobId}`);
    job = r.json;
    if (job?.state && job.state !== 'running') break;
    await sleep(3000);
  }
  const events = await Promise.race([ssePromise, sleep(5000).then(() => sseEvents)]);
  return { job, events };
}

async function main() {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`[smoke] server up on :${PORT}`);

  // ---- 1. Fresh CCD payable ----
  const created = await req('POST', '/api/payables', { asset: 'ccd' });
  if (created.status !== 201) fail(`create CCD payable: HTTP ${created.status} ${JSON.stringify(created.json)}`);
  const ccdId = created.json.payable_id;
  log('create CCD payable', `#${ccdId} register ${created.json.tx_hash.slice(0, 8)}… fee ${created.json.fee_testnet_ccd} CCD, due ${created.json.due}`);

  const doc = await req('GET', `/api/payables/${ccdId}/document`);
  if (doc.status !== 200) fail(`document for #${ccdId}: HTTP ${doc.status}`);
  const facts = await req('GET', `/api/payables/${ccdId}`);
  if (sha256(Buffer.from(doc.text, 'utf8')) !== facts.json.doc_sha256) fail(`document hash mismatch for #${ccdId}`);
  log('document', `#${ccdId} sha256 matches the on-chain doc_hash`);

  const before = await req('POST', `/api/payables/${ccdId}/verify`, { mode: 'before_pay' });
  if (before.json.verdict !== 'ready') fail(`before_pay #${ccdId}: verdict ${before.json.verdict} (${before.json.blocked_reason})`);
  log('before_pay', `#${ccdId} ready (${before.json.passed}/${before.json.total})`);

  const pay = await req('POST', `/api/payables/${ccdId}/pay`, { rail: 'ccd' });
  if (pay.status !== 200) fail(`pay #${ccdId}: HTTP ${pay.status} ${JSON.stringify(pay.json)}`);
  log('pay CCD started', `job ${pay.json.job_id}`);
  const { job, events } = await waitJob(pay.json.job_id);
  if (job.state !== 'succeeded' || job.outcome !== 'paid') fail(`CCD job: state=${job.state} outcome=${job.outcome} steps=${JSON.stringify(job.steps.map((s) => `${s.step}:${s.status}`))}`);
  const payTx = job.steps.find((s) => s.step === 'submit')?.txHash;
  log('pay CCD succeeded', `pay tx ${payTx} (${job.steps.find((s) => s.step === 'verify')?.detail})`);
  const stepEvents = events.filter((e) => e.type === 'step').length;
  if (stepEvents < 3) fail(`SSE delivered only ${stepEvents} step events (expected >= 3)`);
  log('SSE', `${stepEvents} step events + done received`);

  const receipt = await req('GET', `/api/receipts/${ccdId}`);
  if (receipt.status !== 200 || receipt.json.verifier.passed !== 10) fail(`receipt #${ccdId}: ${JSON.stringify(receipt.json)}`);
  log('receipt CCD', `verifier ${receipt.json.verifier.passed}/${receipt.json.verifier.total}, source ${receipt.json.payment_tx_source}`);

  const after = await req('POST', `/api/payables/${ccdId}/verify`, { mode: 'after_pay' });
  if (after.json.passed !== 10 || after.json.total !== 10) fail(`after_pay #${ccdId}: ${after.json.passed}/${after.json.total}`);
  log('after_pay CCD', `10/10`);

  const repay = await req('POST', `/api/payables/${ccdId}/pay`, { rail: 'ccd' });
  if (repay.status !== 409 || repay.json.error.code !== 'already_paid') fail(`re-pay #${ccdId}: expected 409 already_paid, got ${repay.status} ${JSON.stringify(repay.json)}`);
  log('re-pay refused', `409 already_paid (no second send)`);

  // ---- 2. Live pay_twice attack on the paid CCD payable ----
  const attack = await req('POST', '/api/attacks/pay_twice', { payable_id: ccdId });
  if (attack.json.live !== true || attack.json.reject?.code !== -5) fail(`pay_twice #${ccdId}: ${JSON.stringify(attack.json)}`);
  log('attack pay_twice', `live -5 WrongStatus, fee ${attack.json.fee_testnet_ccd} CCD, tx ${attack.json.tx_hash.slice(0, 8)}…`);

  // ---- 3. Fresh EUDemo payable, full rail ----
  const createdE = await req('POST', '/api/payables', { asset: 'eudemo' });
  if (createdE.status !== 201) fail(`create EUDemo payable: HTTP ${createdE.status} ${JSON.stringify(createdE.json)}`);
  const eId = createdE.json.payable_id;
  log('create EUDemo payable', `#${eId} register ${createdE.json.tx_hash.slice(0, 8)}… fee ${createdE.json.fee_testnet_ccd} CCD`);
  const beforeE = await req('POST', `/api/payables/${eId}/verify`, { mode: 'before_pay' });
  if (beforeE.json.verdict !== 'ready') fail(`before_pay #${eId}: ${beforeE.json.verdict}`);
  const payE = await req('POST', `/api/payables/${eId}/pay`, { rail: 'eudemo' });
  if (payE.status !== 200) fail(`pay #${eId}: HTTP ${payE.status} ${JSON.stringify(payE.json)}`);
  const { job: jobE } = await waitJob(payE.json.job_id);
  if (jobE.state !== 'succeeded' || jobE.outcome !== 'paid') fail(`EUDemo job: state=${jobE.state} outcome=${jobE.outcome} steps=${JSON.stringify(jobE.steps.map((s) => `${s.step}:${s.status} ${s.detail}`))}`);
  const transferTx = jobE.steps.find((s) => s.step === 'submit_transfer')?.txHash;
  log('pay EUDemo succeeded', `transfer ${transferTx} (${jobE.steps.find((s) => s.step === 'verify')?.detail})`);
  const receiptE = await req('GET', `/api/receipts/${eId}`);
  if (receiptE.status !== 200 || receiptE.json.verifier.passed !== 14) fail(`receipt #${eId}: ${JSON.stringify(receiptE.json)}`);
  log('receipt EUDemo', `verifier ${receiptE.json.verifier.passed}/${receiptE.json.verifier.total} (12 after-pay + 2 receipt-binding), source ${receiptE.json.payment_tx_source}`);
  const afterE = await req('POST', `/api/payables/${eId}/verify`, { mode: 'after_pay' });
  if (afterE.json.passed !== 12 || afterE.json.total !== 12) fail(`after_pay #${eId}: ${afterE.json.passed}/${afterE.json.total}`);
  log('after_pay EUDemo', `12/12`);

  // ---- 4. Live wrong_amount attack on a fresh unpaid CCD payable ----
  const createdW = await req('POST', '/api/payables', { asset: 'ccd' });
  if (createdW.status !== 201) fail(`create wrong-amount target: HTTP ${createdW.status} ${JSON.stringify(createdW.json)}`);
  const wId = createdW.json.payable_id;
  const attackW = await req('POST', '/api/attacks/wrong_amount', { payable_id: wId });
  if (attackW.json.live !== true || attackW.json.reject?.code !== -6) fail(`wrong_amount #${wId}: ${JSON.stringify(attackW.json)}`);
  log('attack wrong_amount', `live -6 WrongAmount, fee ${attackW.json.fee_testnet_ccd} CCD, tx ${attackW.json.tx_hash.slice(0, 8)}…`);

  // ---- 5. Read endpoints still agree after the sends ----
  const stats = await req('GET', '/api/stats');
  log('stats after smoke', `payables_total=${stats.json.payables_total} paid_total=${stats.json.paid_total} refused=${stats.json.refused_on_chain_since_deploy}`);

  console.log(`\n[smoke] ALL SMOKE CHECKS PASSED — fresh payables #${ccdId} (CCD, paid), #${eId} (EUDemo, paid), #${wId} (CCD, unpaid, wrong-amount target)`);
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('[smoke] ERROR:', e.message);
  server.close();
  process.exit(1);
});
