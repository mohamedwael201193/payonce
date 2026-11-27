// qa/e2e-live.mjs — live end-to-end test of the PayOnce API + Concordium TESTNET.
//
//   node qa/e2e-live.mjs [--api <url>] [--out <file.json>] [--no-direct] [--skip-pay]
//
// Default target: the deployed API (https://payonce-api-n98a.onrender.com).
// Every step is a real request or a real testnet transaction; nothing is mocked.
//
//   A. contract: the GET routes the frontend uses answer with the shapes the
//      frontend's zod schemas require (FRONTEND_MAP section 2); /api/stats is a
//      recount of /api/invoices and every refusal it counts re-reads as rejected.
//   B. per seller (1476, 1506) x per rail (CCD, EUDemo dust 0.01):
//        list -> verify(before_pay) -> pay (POST /api/payables/:id/pay) -> job ->
//        confirm (the job's chain steps) -> receipt -> verify(after_pay) ->
//        independent keyless verifier (no key, no env) must PASS.
//      The invoice is created through POST /api/payables. When that route
//      fails (it did on the deployed API: chain Duplicate -2) the failure is
//      reported as a FAIL row and, with wallet keys, the same lab invoice is
//      registered directly on chain so the pay flow can still be tested.
//      A seller whose write routes the API refuses (config.build.seller_writes)
//      is verified read-only from its recorded payments and its pay step is
//      reported BLOCKED, never faked.
//   C. negatives (each ends in an on-chain reject or a co-signer refusal):
//        double pay (API + real second tx), wrong amount (real tx), tamper
//        (document hash), fraud payable (co-signer dry run + a stranger
//        registering under the seller's agent token), wrong payee (co-signer
//        refuses; when bypassed the chain cannot inspect a PLT transfer, so the
//        independent verifier is what catches it) and stranger confirm (-17).
//      Group C-direct needs the wallet keys (read in-process from an .env,
//      never printed); without them those rows are SKIP.
//
// Secrets: keys are read in-process only, never printed or written. All error
// text goes through redact() (exact secret values, 12+ word runs, 64-hex).
// Budgets: the API allows 3 new invoices and 3 attack sends per hour per IP;
// the script reads /api/health and falls back or skips instead of failing.
import { readFileSync, existsSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const API = (opt('--api', process.env.PAYONCE_E2E_API ?? 'https://payonce-api-n98a.onrender.com')).replace(/\/$/, '');
const OUT = opt('--out', join(HERE, 'out', 'e2e-live.json'));
const NO_DIRECT = args.includes('--no-direct');
const SKIP_PAY = args.includes('--skip-pay');

// Minimal .env parser (KEY=VALUE, optional quotes) so this script needs no dependency.
function parseDotenv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// ---- secrets: load in-process, never print ----
const SECRETS = [];
function loadKeys() {
  const candidates = [process.env.PAYONCE_E2E_ENV, join(REPO, '.env'), join(REPO, '..', '.env'), join(REPO, '..', '..', '.env')].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const e = parseDotenv(readFileSync(p, 'utf8'));
    const priv = e.CONCORDIUM_WALLET_PRIVATE_KEY ?? e.private_key;
    const seed = e.CONCORDIUM_WALLET_SEED_PHRASE ?? e.seed_phares ?? e.seed_phrase;
    if (priv && seed) {
      process.env.CONCORDIUM_WALLET_PRIVATE_KEY = priv.trim();
      process.env.CONCORDIUM_WALLET_SEED_PHRASE = seed.trim();
      SECRETS.push(priv.trim(), seed.trim(), ...seed.trim().split(/\s+/));
      for (const k of ['GITHUB_TOKEN', 'VERCEL_TOKEN', 'render_api_key', 'facilitator_api_key', 'easy_post_api']) if (e[k]) SECRETS.push(e[k].trim());
      return true;
    }
  }
  return false;
}
function redact(text) {
  let s = String(text ?? '');
  for (const sec of SECRETS) if (sec && sec.length >= 6) s = s.split(sec).join('[redacted]');
  s = s.replace(/\b(?:[a-z]{3,12}\s+){11,}[a-z]{3,12}\b/gi, '[redacted-words]');
  s = s.replace(/\b[0-9a-f]{64}\b/gi, '[hex64]');
  return s.slice(0, 600);
}
const HAVE_KEYS = !NO_DIRECT && loadKeys();

// ---- results ----
const rows = [];
function row(seller, rail, step, status, detail = '', txs = {}) {
  rows.push({ seller, rail, step, status, detail: String(detail).slice(0, 500), txs });
  console.log(`${status.padEnd(14)} ${seller}/${rail} ${step}${detail ? ' - ' + String(detail).slice(0, 220) : ''}`);
  for (const [k, v] of Object.entries(txs)) console.log(`                 ${k}: ${v}`);
}
const pass = (s, r, st, d, t) => row(s, r, st, 'PASS', d, t);
const fail = (s, r, st, d, t) => row(s, r, st, 'FAIL', d, t);
function check(cond, s, r, st, okMsg, badMsg, txs) { return cond ? pass(s, r, st, okMsg, txs) : fail(s, r, st, badMsg, txs); }

// ---- http ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(method, path, body = null, { retries = 3, timeoutMs = 90_000, retryOn500 = method === 'GET' } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(API + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* text body */ }
      const transient = [502, 503, 504].includes(res.status) || (retryOn500 && res.status === 500);
      if (transient && i < retries) { await sleep(2500 * (i + 1)); continue; }
      return { status: res.status, json, text };
    } catch (e) {
      last = e;
      if (i < retries) await sleep(2500 * (i + 1));
    }
  }
  throw new Error(`request failed: ${method} ${path}: ${redact(last?.message)}`);
}
const GET = (p, o) => http('GET', p, null, o);
const POST = (p, b, o) => http('POST', p, b ?? {}, o);

// ---- shape checks mirroring frontend/src/lib/api.ts (FRONTEND_MAP section 2) ----
const is = {
  str: (v) => typeof v === 'string', num: (v) => typeof v === 'number', bool: (v) => typeof v === 'boolean',
  obj: (v) => v && typeof v === 'object' && !Array.isArray(v), arr: Array.isArray,
};
function shape(v, spec) {
  const bad = [];
  for (const [k, t] of Object.entries(spec)) {
    const optional = t.endsWith('?');
    const ty = optional ? t.slice(0, -1) : t;
    const val = v?.[k];
    if (val === undefined || val === null) { if (!optional && !ty.endsWith('|null')) bad.push(`${k} missing`); continue; }
    if (!is[ty.replace('|null', '')](val)) bad.push(`${k} not ${ty}`);
  }
  return bad;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const short = (h) => (h ? `${h.slice(0, 8)}...${h.slice(-6)}` : '-');
const isHash = (h) => /^[0-9a-f]{64}$/.test(h ?? '');

function runKeylessVerifier({ id, txHash, docText, rail, seller, reserve, confirm }) {
  const dir = mkdtempSync(join(tmpdir(), 'payonce-e2e-'));
  const docPath = join(dir, `invoice-${id}.txt`);
  writeFileSync(docPath, docText);
  const argv = [join(REPO, 'api', 'src', 'verify-payable-v2.mjs'), String(id), txHash, '--doc', docPath, '--rail', rail];
  if (seller) argv.push('--seller', seller);
  if (reserve) argv.push('--reserve', reserve);
  if (confirm) argv.push('--confirm', confirm);
  // Keyless: the child sees no wallet secret at all (a clean environment).
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PAYONCE_DATA_DIR: dir };
  try {
    const out = execFileSync(process.execPath, argv, { env, encoding: 'utf8', timeout: 150_000 });
    return { ok: /ALL CHECKS PASS/.test(out), line: out.trim().split('\n').pop(), out };
  } catch (e) {
    const out = `${e.stdout ?? ''}`;
    return { ok: false, line: redact(out.split('\n').filter((l) => /FAIL|CHECKS/.test(l)).join(' | ') || e.message), out };
  }
}

async function pollJob(jobId, timeoutMs = 480_000) {
  const t0 = Date.now();
  let job = null;
  while (Date.now() - t0 < timeoutMs) {
    const r = await GET(`/api/jobs/${encodeURIComponent(jobId)}`, { retries: 2 });
    job = r.json;
    if (job && job.state && job.state !== 'running') return job;
    await sleep(3000);
  }
  return job;
}

// ---- direct chain access (wallet keys, in-process) ----
let chainCache = null;
async function chainHelpers() {
  if (chainCache) return chainCache;
  const imp = (p) => import(pathToFileURL(join(REPO, p)).href);
  const chain = await imp('api/src/chain-v2.mjs');
  const { backend } = await imp('api/src/backend.mjs');
  const conf = await imp('api/src/config.mjs');
  const jobs = await imp('api/src/jobs.mjs');
  const docs = await imp('api/src/docs.mjs');
  const { v2enc } = await backend();
  const sig = await chain.signers();
  const c = await chain.grpc();
  chainCache = { ...chain, c, sig, v2enc, conf, docs, rejectOf: jobs.rejectOf, rejectInfo: jobs.rejectInfo };
  return chainCache;
}

// Register a lab invoice directly on chain (same fields the API route writes).
async function registerDirect({ sellerAddr, isS2, rail }) {
  const h = await chainHelpers();
  const id = (isS2 ? 80000 : 70000) + (Math.floor(Date.now() / 1000) % 9000) * 1 + (rail === 'eudemo' ? 1 : 0) * 5000 % 9000;
  const amount = rail === 'ccd' ? 500000n : 10000n;
  const payee = isS2 ? sellerAddr : rail === 'ccd' ? h.conf.PAYEE_CCD : h.conf.PAYEE_EUDEMO;
  const dueMs = Date.now() + 24 * 3_600_000;
  // the exact lab invoice the API regenerates and serves, so its hash matches the chain
  const docText = h.docs.generateLabDocument({ id, asset: rail === 'ccd' ? 'CCD' : 'EUDemo', amount: amount.toString(), payee, seller: sellerAddr, due: dueMs });
  const docHash = sha256(Buffer.from(docText));
  const sent = await h.sendUpdate(h.c, {
    from: isS2 ? h.sig.seller2 : h.sig.owner, receiveName: 'register_payable', maxEnergy: 6000n,
    parameterHex: h.v2enc.encodeV2RegisterPayable({ id, payee, amount: amount.toString(), asset: rail === 'ccd' ? 'CCD' : 'EUDemo', dueMs, docHashHex: docHash, token: isS2 ? h.conf.SELLER2_TOKEN : h.conf.OWNER_TOKEN, expected: h.conf.PAYER_ADDRESS, legal: null }),
  });
  const st = await h.waitFinalized(h.c, sent.txHash);
  const rr = h.rejectOf(st);
  if (rr) throw new Error(`direct registration rejected (${h.rejectInfo(rr.rejectReason).name})`);
  return { id, txHash: sent.txHash, docText };
}

// =====================================================================
const state = { invoicesLeft: 0, attacksLeft: 0, S1: null, S2: null, cfg: null };
const paid = {}; // `${sellerKey}:${rail}` -> { id, legs, payTx, docHash, docText, sellerAddr }
const created = {};

async function payFlow({ sellerKey, sellerAddr, isS2, rail }) {
  const S = sellerKey;
  let id = null, regTx = null, docText = null, via = 'api';
  // ---- create ----
  if (state.invoicesLeft >= 1) {
    const cr = await POST('/api/payables', { asset: rail, seller: sellerAddr }, { retries: 0, timeoutMs: 240_000 });
    state.invoicesLeft--;
    if (cr.status === 201) {
      id = cr.json.payable_id; regTx = cr.json.tx_hash;
      pass(S, rail, 'create invoice via POST /api/payables (register_payable on chain)', `payable ${id}`, { register_tx: regTx });
    } else {
      fail(S, rail, 'create invoice via POST /api/payables', `HTTP ${cr.status} ${cr.json?.error?.code ?? ''} ${cr.json?.error?.message ?? cr.text.slice(0, 120)}`);
    }
  } else {
    row(S, rail, 'create invoice via POST /api/payables', 'SKIP', 'new-invoice budget (3/hour/IP) is empty');
  }
  if (id === null) {
    if (!HAVE_KEYS) { row(S, rail, 'pay flow', 'SKIP', 'no invoice could be created through the API and no wallet keys are loaded for the direct fallback'); return; }
    try {
      const d = await registerDirect({ sellerAddr, isS2, rail });
      id = d.id; regTx = d.txHash; docText = d.docText; via = 'direct';
      row(S, rail, 'fallback: register the lab invoice directly on chain', 'INFO', `payable ${id} (the pay flow below is the API's)`, { register_tx: regTx });
    } catch (e) { fail(S, rail, 'fallback: direct registration', redact(e.message)); return; }
  }
  created[`${S}:${rail}`] = { id, via, register_tx: regTx };
  const q = `?seller=${sellerAddr}`;
  // ---- list + facts + document ----
  const lst = await GET('/api/invoices');
  const listed = (lst.json?.items ?? []).find((i) => i.payable_id === id && i.seller === sellerAddr);
  if (via === 'api') check(!!listed && listed.status === 'Unpaid', S, rail, 'list (GET /api/invoices)', `payable ${id} listed Unpaid, ${listed?.amount_display}`, `payable ${id} not listed as Unpaid`);
  else row(S, rail, 'list (GET /api/invoices)', 'INFO', `payable ${id} was registered outside the API, so the list (built from the API's own ids) can differ; read through GET /api/payables/${id} instead`);
  const pb = await GET(`/api/payables/${id}${q}`);
  check(pb.status === 200 && pb.json?.status?.kind === 'unpaid' && pb.json?.seller === sellerAddr, S, rail, 'payable facts', `unpaid; ${pb.json?.amount_display}; seller ${short(pb.json?.seller)}`, `HTTP ${pb.status} ${JSON.stringify(pb.json?.status)}`);
  const docHash = pb.json?.doc_sha256;
  if (docText === null) {
    const docR = await GET(`/api/payables/${id}/document${q}`);
    docText = docR.status === 200 ? docR.text : null;
    check(docText !== null && sha256(Buffer.from(docText)) === docHash, S, rail, 'document hash', `sha256(GET document) == on-chain doc hash ${short(docHash)}`, `document HTTP ${docR.status}`);
  } else {
    check(sha256(Buffer.from(docText)) === docHash, S, rail, 'document hash', `sha256(invoice text) == on-chain doc hash ${short(docHash)}`, 'document hash differs from chain');
  }
  // ---- verify before pay ----
  const vb = await POST(`/api/payables/${id}/verify${q}`, { mode: 'before_pay', doc_sha256: docHash });
  check(vb.json?.verdict === 'ready', S, rail, 'verify before_pay', `verdict ready, ${vb.json?.passed}/${vb.json?.total} checks`, `verdict ${vb.json?.verdict} (${vb.json?.blocked_reason}) ${JSON.stringify((vb.json?.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.id))}`);
  if (vb.json?.verdict !== 'ready') return;
  if (SKIP_PAY) { row(S, rail, 'pay', 'SKIP', '--skip-pay'); return; }
  // ---- pay ----
  const pr = await POST(`/api/payables/${id}/pay`, { rail, doc_sha256: docHash, seller: sellerAddr }, { retries: 0 });
  if (pr.status !== 200) { fail(S, rail, 'pay (POST /api/payables/:id/pay)', `HTTP ${pr.status} ${pr.json?.error?.code} ${pr.json?.error?.message}`); return; }
  pass(S, rail, 'pay (POST /api/payables/:id/pay)', `job ${pr.json.job_id}; steps ${pr.json.steps.join(' > ')}`);
  const job = await pollJob(pr.json.job_id);
  const stepTxs = Object.fromEntries((job?.steps ?? []).filter((s) => s.txHash).map((s) => [s.step, s.txHash]));
  const jbad = shape(job, { job_id: 'str', payable_id: 'num', rail: 'str', state: 'str', steps: 'arr', started_at: 'str' });
  check(job?.state === 'succeeded' && job?.outcome === 'paid' && jbad.length === 0, S, rail, 'confirm (job: chain steps finalised, verifier run)', `state ${job?.state}/${job?.outcome}; ${(job?.steps ?? []).map((s) => `${s.step}:${s.status}`).join(' ')}`, `state ${job?.state}/${job?.outcome}; ${jbad.join(', ')}; ${(job?.steps ?? []).filter((s) => s.status !== 'ok').map((s) => `${s.step}:${s.status} ${s.detail}`).join(' | ')}`, stepTxs);
  if (job?.state !== 'succeeded') return;
  // ---- receipt ----
  const rc = await GET(`/api/receipts/${id}${q}`);
  const rbad = shape(rc.json, { payable_id: 'num', amount_display: 'str', payee: 'str', payer_label: 'str', txs: 'arr', verifier: 'obj|null', payment_tx_source: 'str' });
  const legs = Object.fromEntries((rc.json?.txs ?? []).map((t) => [t.label, t.tx_hash]));
  const need = rail === 'ccd' ? ['Payment'] : ['Reservation', 'Transfer', 'Confirm'];
  check(rc.status === 200 && rbad.length === 0 && need.every((l) => isHash(legs[l])) && rc.json.verifier && rc.json.verifier.passed === rc.json.verifier.total, S, rail, 'receipt (GET /api/receipts/:id)', `legs ${Object.keys(legs).join('+')}; verifier ${rc.json?.verifier?.passed}/${rc.json?.verifier?.total}`, `HTTP ${rc.status}; ${rbad.join(', ')}; legs ${Object.keys(legs)}; verifier ${JSON.stringify(rc.json?.verifier)}`, legs);
  const va = await POST(`/api/payables/${id}/verify${q}`, { mode: 'after_pay', doc_sha256: docHash });
  check(va.json?.verdict === 'paid' && va.json.passed === va.json.total, S, rail, 'verify after_pay (API)', `verdict paid, ${va.json?.passed}/${va.json?.total}`, `verdict ${va.json?.verdict} ${va.json?.passed}/${va.json?.total} ${va.json?.blocked_reason}`);
  const payTx = rail === 'ccd' ? legs.Payment : legs.Transfer;
  const kv = runKeylessVerifier({ id, txHash: payTx, docText, rail, seller: sellerAddr, reserve: legs.Reservation, confirm: legs.Confirm });
  check(kv.ok, S, rail, 'independent keyless verifier', kv.line, kv.line);
  paid[`${S}:${rail}`] = { id, legs, payTx, docHash, docText, sellerAddr };
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`PayOnce live E2E against ${API}`);
  console.log(`started ${startedAt}; wallet keys: ${HAVE_KEYS ? 'loaded in-process (never printed)' : 'not loaded'}`);

  // ---------------- A. contract checks ----------------
  const [cfgR, healthR, statsR, invR] = await Promise.all([GET('/api/config'), GET('/api/health'), GET('/api/stats'), GET('/api/invoices')]);
  const cfg = cfgR.json, health = healthR.json, stats = statsR.json, inv = invR.json;
  state.cfg = cfg;
  let bad = shape(cfg, { network: 'str', registry: 'obj', cis8004_test_instance: 'obj', reservation_secs: 'num', co_signer_margin_secs: 'num', assets: 'obj', payer_label: 'str', sponsor_label: 'str', explorer: 'obj', vendor_list: 'arr', sellers: 'arr?', build: 'obj', limits: 'obj', verifier: 'obj', as_of: 'str' });
  check(cfgR.status === 200 && bad.length === 0, 'api', '-', 'GET /api/config', 'matches the frontend schema', `HTTP ${cfgR.status}; ${bad.join(', ')}`);
  bad = shape(health, { chain: 'obj', node_busy: 'bool', payer: 'obj', sponsor: 'obj', wallet_eudemo: 'obj', co_signer: 'obj', budget: 'obj' });
  check(healthR.status === 200 && bad.length === 0 && health?.chain?.reachable === true, 'api', '-', 'GET /api/health', `chain reachable; payer ${health?.payer?.status}, wallet_eudemo ${health?.wallet_eudemo?.status}, co_signer ${health?.co_signer?.status}; budget ${JSON.stringify(health?.budget)}`, `HTTP ${healthR.status}; reachable=${health?.chain?.reachable}; ${bad.join(', ')}`);
  bad = shape(stats, { payables_total: 'num', paid_total: 'num', refused_on_chain_since_deploy: 'num', last_verifier_run_at: 'str|null', voided_total: 'num?', reserved_total: 'num?' });
  check(statsR.status === 200 && bad.length === 0, 'api', '-', 'GET /api/stats', `payables ${stats?.payables_total}, paid ${stats?.paid_total}, refused ${stats?.refused_on_chain_since_deploy}`, `HTTP ${statsR.status}; ${bad.join(', ')}`);
  const items = inv?.items ?? [];
  check(invR.status === 200 && items.length > 0 && items.every((i) => is.num(i.payable_id) && is.str(i.seller) && ['ccd', 'eudemo'].includes(i.asset) && is.str(i.amount_display) && is.str(i.due) && is.str(i.status) && is.str(i.label)), 'api', '-', 'GET /api/invoices', `${items.length} rows from ${new Set(items.map((i) => i.seller)).size} sellers`, `HTTP ${invR.status}`);
  check(stats && items.length === stats.payables_total && items.filter((i) => i.status === 'Paid').length === stats.paid_total, 'api', '-', 'stats == recount of /api/invoices', 'payables_total and paid_total equal the listed rows', `stats ${stats?.payables_total}/${stats?.paid_total} vs list ${items.length}/${items.filter((i) => i.status === 'Paid').length} (a payment landing between the two reads can differ by one; rerun)`);
  if (stats?.sources) {
    check(stats.sources.refused_on_chain_since_deploy?.kind === 'recorded' && !!stats.generated_at, 'api', '-', 'stats provenance', `generated_at ${stats.generated_at}; ${Object.entries(stats.sources).map(([k, v]) => `${k}=${v.kind}`).join(', ')}`, 'stats.sources / generated_at missing');
    const refR = await GET('/api/stats/refusals');
    check(refR.status === 200 && refR.json?.count === stats.refused_on_chain_since_deploy, 'api', '-', 'GET /api/stats/refusals', `count ${refR.json?.count} equals refused_on_chain_since_deploy`, `HTTP ${refR.status}`);
    const hashes = (refR.json?.items ?? []).map((i) => i.tx_hash);
    let rejected = 0; const unknown = [];
    for (let i = 0; i < hashes.length; i += 6) {
      const rs = await Promise.all(hashes.slice(i, i + 6).map((h) => GET(`/api/tx/${h}/status`, { retries: 2 }).catch(() => ({ status: 0 }))));
      rs.forEach((r, k) => { if (r.json?.reject && is.num(r.json.reject.code)) rejected++; else unknown.push(hashes[i + k]); });
    }
    check(hashes.length > 0 && unknown.length === 0, 'api', '-', 'every counted refusal re-reads as rejected on chain', `${rejected}/${hashes.length} via /api/tx/:hash/status`, `${unknown.length} not confirmed as rejected: ${unknown.slice(0, 3).map(short).join(', ')}`);
  } else {
    row('api', '-', 'stats provenance (generated_at, sources[field])', 'PENDING-DEPLOY', 'the deployed API predates this branch; merge + deploy to get it');
  }
  const S1 = cfg?.sellers?.[0]?.seller, S2 = cfg?.sellers?.[1]?.seller;
  state.S1 = S1; state.S2 = S2;
  check(S1 && S2 && cfg.sellers[0].agent_token === 1476 && cfg.sellers[1].agent_token === 1506, 'api', '-', 'sellers 1476 / 1506 configured', `S1 ${short(S1)} token ${cfg?.sellers?.[0]?.agent_token}; S2 ${short(S2)} token ${cfg?.sellers?.[1]?.agent_token}`, 'sellers missing from /api/config');
  const sellerWrites = cfg?.build?.seller_writes ?? ['seller_1'];
  const s2Writes = sellerWrites.includes('seller_2');
  row('api', '-', 'seller write support (config.build.seller_writes)', 'INFO', JSON.stringify(sellerWrites));
  const jr = await GET('/api/judges/files');
  check(jr.status === 200 && jr.json?.files?.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), 'api', '-', 'GET /api/judges/files', `${jr.json?.files?.length} files with sha256`, `HTTP ${jr.status}`);
  state.invoicesLeft = health?.budget?.new_invoices_left_this_hour ?? 0;
  state.attacksLeft = health?.budget?.attack_sends_left_this_hour ?? 0;

  // ---------------- B. pay flows ----------------
  for (const rail of ['ccd', 'eudemo']) await payFlow({ sellerKey: 'seller1', sellerAddr: S1, isS2: false, rail });
  if (s2Writes) {
    for (const rail of ['ccd', 'eudemo']) await payFlow({ sellerKey: 'seller2', sellerAddr: S2, isS2: true, rail });
  } else {
    await seller2ReadOnly(items, S1, S2);
  }

  // ---------------- C. negatives through the API ----------------
  for (const key of Object.keys(paid)) {
    const p = paid[key];
    const [sk, rail] = key.split(':');
    const again = await POST(`/api/payables/${p.id}/pay`, { rail, doc_sha256: p.docHash, seller: p.sellerAddr }, { retries: 0 });
    check(again.status === 409 && again.json?.error?.code === 'already_paid', sk, rail, 'double pay: the API refuses (already_paid)', `HTTP 409 ${again.json?.error?.message?.slice(0, 80)}`, `HTTP ${again.status} ${again.json?.error?.code}`);
    if (sk !== 'seller1') continue; // attack sends are seller-1 only
    if (state.attacksLeft < 1) { row(sk, rail, 'double pay: second payment sent to the chain', 'SKIP', 'attack-send budget (3/hour/IP) is empty'); continue; }
    const at = await POST('/api/attacks/pay_twice', { payable_id: p.id, mode: 'send_to_chain' }, { retries: 0, timeoutMs: 240_000 });
    state.attacksLeft--;
    const expected = rail === 'ccd' ? -5 : -16;
    check(at.json?.outcome === 'refused' && at.json?.reject?.code === expected && isHash(at.json?.tx_hash), sk, rail, 'double pay: on-chain reject of a real second payment', `${at.json?.reject?.name} (${at.json?.reject?.code}), fee ${at.json?.fee_testnet_ccd} testnet CCD`, `outcome ${at.json?.outcome} reject ${JSON.stringify(at.json?.reject)} (expected ${expected})`, { rejected_tx: at.json?.tx_hash });
  }
  // wrong amount (CCD, real tx) + tamper on one fresh unpaid CCD payable
  if (!SKIP_PAY) {
    let id = null, regTx = null, via = 'api';
    if (state.invoicesLeft >= 1) {
      const cr = await POST('/api/payables', { asset: 'ccd' }, { retries: 0, timeoutMs: 240_000 });
      state.invoicesLeft--;
      if (cr.status === 201) { id = cr.json.payable_id; regTx = cr.json.tx_hash; } else fail('seller1', 'ccd', 'wrong amount: create payable via the API', `HTTP ${cr.status} ${cr.json?.error?.code}`);
    }
    if (id === null && HAVE_KEYS) {
      try { const d = await registerDirect({ sellerAddr: S1, isS2: false, rail: 'ccd' }); id = d.id; regTx = d.txHash; via = 'direct'; } catch (e) { fail('seller1', 'ccd', 'wrong amount: direct registration', redact(e.message)); }
    }
    if (id === null) row('seller1', 'ccd', 'wrong amount + tamper', 'SKIP', 'no unpaid payable could be created');
    else {
      if (state.attacksLeft < 1) row('seller1', 'ccd', 'wrong amount: on-chain reject', 'SKIP', 'attack-send budget empty');
      else {
        const at = await POST('/api/attacks/wrong_amount', { payable_id: id }, { retries: 0, timeoutMs: 240_000 });
        state.attacksLeft--;
        check(at.json?.outcome === 'refused' && at.json?.reject?.code === -6 && isHash(at.json?.tx_hash), 'seller1', 'ccd', 'wrong amount: on-chain reject of amount+1', `${at.json?.reject?.name} (${at.json?.reject?.code})`, `outcome ${at.json?.outcome} reject ${JSON.stringify(at.json?.reject)}`, { register_tx: regTx, rejected_tx: at.json?.tx_hash });
      }
      const forged = sha256(Buffer.from('tampered invoice: pay 9999 CCD to a stranger'));
      const vb = await POST(`/api/payables/${id}/verify`, { mode: 'before_pay', doc_sha256: forged });
      check(vb.json?.verdict === 'blocked' && /doc/.test(vb.json?.blocked_reason ?? ''), 'seller1', 'ccd', 'tamper: verify blocks a forged document', `verdict blocked (${vb.json?.blocked_reason})`, `verdict ${vb.json?.verdict} ${vb.json?.blocked_reason}`);
      const pr = await POST(`/api/payables/${id}/pay`, { rail: 'ccd', doc_sha256: forged }, { retries: 0 });
      check(pr.status === 409 && pr.json?.error?.code === 'doc_mismatch', 'seller1', 'ccd', 'tamper: pay refuses a forged document', 'HTTP 409 doc_mismatch, nothing sent', `HTTP ${pr.status} ${pr.json?.error?.code}`);
      const still = await GET(`/api/payables/${id}`);
      check(still.json?.status?.kind === 'unpaid', 'seller1', 'ccd', 'tamper: payable still unpaid', 'unpaid after every refused attempt', `status ${still.json?.status?.kind}${via === 'direct' ? '' : ''}`);
    }
  }
  // fraud payable: the unlisted-seller co-signer decision, live
  {
    const at = await POST('/api/attacks/unlisted_seller', { payable_id: paid['seller1:ccd']?.id ?? 1 }, { retries: 2, retryOn500: true });
    const dry = at.json?.recorded_example?.cosigner_dry_run_live;
    check(at.status === 200 && at.json?.tx_sent === false && dry?.decision === 'REFUSE' && dry?.code === 'no-approval', 'seller1', '-', 'fraud payable: co-signer REFUSES an unlisted seller (live dry run, no-approval)', `REFUSE ${dry?.code}; vendor list read live: ${at.json?.recorded_example?.vendor_list_live?.length} sellers`, `HTTP ${at.status} outcome ${at.json?.outcome} dry-run ${JSON.stringify(dry)}`);
  }

  // ---------------- D. direct on-chain negatives ----------------
  if (!HAVE_KEYS) {
    for (const s of ['wrong payee (co-signer refuses; bypassed, the verifier catches it)', 'stranger confirm (NotPayer -17)', 'fraud registration (stranger uses the seller agent token)']) row('seller1', 'eudemo', s, 'SKIP', 'no wallet keys loaded (set PAYONCE_E2E_ENV to an .env holding them, or drop --no-direct)');
  } else {
    await directNegatives({ S1, S2 });
  }

  // ---------------- summary ----------------
  const counts = rows.reduce((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, {});
  const finishedAt = new Date().toISOString();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ api: API, started_at: startedAt, finished_at: finishedAt, counts, created, paid: Object.fromEntries(Object.entries(paid).map(([k, v]) => [k, { id: v.id, legs: v.legs, payTx: v.payTx }])), rows }, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(counts));
  console.log(`results written to ${OUT}`);
  process.exit(counts.FAIL ? 1 : 0);
}

// Seller 2 when the API does not accept its writes: verify its recorded payments read-only.
async function seller2ReadOnly(items, S1, S2) {
  const S = 'seller2';
  const s2items = items.filter((i) => i.seller === S2);
  check(s2items.length >= 2, S, '-', 'list (seller-2 rows in /api/invoices)', `${s2items.length} rows: ${s2items.map((i) => `${i.payable_id}:${i.status}`).join(' ')}`, 'no seller-2 rows listed');
  for (const it of s2items) {
    const rail = it.asset, id = it.payable_id;
    const pb = await GET(`/api/payables/${id}?seller=${S2}`);
    const docR = await GET(`/api/payables/${id}/document?seller=${S2}`);
    check(pb.status === 200 && pb.json.seller === S2 && docR.status === 200 && sha256(Buffer.from(docR.text)) === pb.json.doc_sha256, S, rail, `payable ${id} facts + document`, `seller ${short(pb.json?.seller)}, document hash matches`, `facts ${pb.status}; doc ${docR.status}`);
    if (/Lab invoice/.test(pb.json?.label ?? '')) pass(S, rail, `payable ${id} label`, `"${pb.json.label}"`);
    else row(S, rail, `payable ${id} label`, 'PENDING-DEPLOY', `deployed API labels it "${pb.json?.label}" (id-only label bug; fixed on this branch: labelFor)`);
    const other = await GET(`/api/payables/${id}?seller=${S1}`);
    check(other.status !== 200 || other.json.seller !== S2, S, rail, `seller 1's payable ${id} is a different payable`, `seller-1 ${id} -> ${other.status === 200 ? short(other.json.seller) : other.status}`, 'seller-1 lookup returned the seller-2 payable');
    if (pb.json?.status?.kind !== 'paid') { row(S, rail, `payable ${id}`, 'INFO', `status ${pb.json?.status?.kind}`); continue; }
    const rc = await GET(`/api/receipts/${id}?seller=${S2}`);
    const legs = Object.fromEntries((rc.json?.txs ?? []).map((t) => [t.label, t.tx_hash]));
    check(rc.status === 200 && rc.json.seller === S2 && rc.json.verifier?.passed === rc.json.verifier?.total, S, rail, `receipt ${id}`, `legs ${Object.keys(legs).join('+')}; verifier ${rc.json?.verifier?.passed}/${rc.json?.verifier?.total}`, `HTTP ${rc.status} verifier ${JSON.stringify(rc.json?.verifier)}`, legs);
    const va = await POST(`/api/payables/${id}/verify?seller=${S2}`, { mode: 'after_pay', doc_sha256: pb.json.doc_sha256 });
    check(va.json?.verdict === 'paid' && va.json.passed === va.json.total, S, rail, `verify after_pay ${id} (API)`, `paid ${va.json?.passed}/${va.json?.total}`, `verdict ${va.json?.verdict} ${va.json?.passed}/${va.json?.total} ${va.json?.blocked_reason}`);
    const kv = runKeylessVerifier({ id, txHash: rail === 'ccd' ? legs.Payment : legs.Transfer, docText: docR.text, rail, seller: S2, reserve: legs.Reservation, confirm: legs.Confirm });
    check(kv.ok, S, rail, `independent keyless verifier ${id}`, kv.line, kv.line);
  }
  const wr = await POST('/api/payables/1/pay', { rail: 'ccd', seller: S2 }, { retries: 0 });
  check(wr.status === 400 && /not supported for writes/.test(wr.json?.error?.message ?? ''), S, '-', 'a seller-2 write is refused loudly (never run as seller 1)', 'HTTP 400 not supported for writes', `HTTP ${wr.status} ${wr.json?.error?.message}`);
  row(S, 'ccd+eudemo', 'pay + confirm through the API', 'PENDING-DEPLOY', `the deployed API refuses seller-2 writes (HTTP ${wr.status}). Seller-2 create + pay is implemented on this branch (config.build.seller_writes); merge + deploy it, then rerun.`);
}

// ---------------------------------------------------------------------
async function directNegatives({ S1, S2 }) {
  const S = 'seller1', rail = 'eudemo';
  let h;
  try { h = await chainHelpers(); } catch (e) { row(S, rail, 'direct negatives', 'BLOCKED', `could not load the chain helpers: ${redact(e.message)}`); return; }
  const { c, sig, v2enc, conf, sendUpdate, sendTokenTransfer, waitFinalized, getPayable, rejectOf, rejectInfo } = h;
  const memoOf = (id) => `payable:${S1}:${id}`;
  const base = 60000 + (Math.floor(Date.now() / 1000) % 9000) * 3;
  const registerEud = async (id, label) => {
    const dueMs = Date.now() + 6 * 3_600_000;
    const docText = `${label}\nInvoice: ${id}\n`;
    const sent = await sendUpdate(c, { from: sig.owner, receiveName: 'register_payable', parameterHex: v2enc.encodeV2RegisterPayable({ id, payee: conf.PAYEE_EUDEMO, amount: '10000', asset: 'EUDemo', dueMs, docHashHex: sha256(Buffer.from(docText)), token: conf.OWNER_TOKEN, expected: conf.PAYER_ADDRESS, legal: null }), maxEnergy: 6000n });
    const st = await waitFinalized(c, sent.txHash);
    return { txHash: sent.txHash, rejected: rejectOf(st), docText };
  };
  const send = async (from, receiveName, parameterHex) => {
    const sent = await sendUpdate(c, { from, receiveName, parameterHex, maxEnergy: 6000n });
    const st = await waitFinalized(c, sent.txHash);
    const rr = rejectOf(st);
    return { txHash: sent.txHash, reject: rr ? rejectInfo(rr.rejectReason) : null };
  };
  const key = (id) => v2enc.encodeV2PayableKey({ seller: S1, id });
  const transfer = async (id, view, recipient) => {
    const exp = Math.floor((Number(view.record.expiresMs) - 60_000) / 1000);
    const tr = await sendTokenTransfer(c, { from: sig.sellerB, recipient, amount: 10000n, memo: memoOf(id), expirySeconds: exp });
    const st = await waitFinalized(c, tr.txHash);
    if (!(st.summary?.events ?? []).some((e) => e.tag === 'TokenTransfer')) throw new Error('setup: the transfer did not execute (no TokenTransfer event)');
    return tr.txHash;
  };

  // ---- D1 wrong payee ----
  try {
    const id = base;
    const reg = await registerEud(id, 'e2e wrong-payee payable');
    if (reg.rejected) throw new Error(`register rejected ${reg.rejected.rejectReason}`);
    const rs = await send(sig.sellerB, 'reserve_plt', key(id));
    if (rs.reject) throw new Error(`reserve rejected ${rs.reject.name}`);
    const view = await getPayable(c, S1, id);
    const wrongPayee = S1; // the lab's own seller account: the dust stays in the lab
    // 1. the co-signer gate decides the transfer BEFORE it is sent
    const dry = await POST('/api/cosigner/dry-run', { payable_id: id, to: wrongPayee, amount: '10000', memo: memoOf(id) }, { retries: 3, retryOn500: true });
    check(dry.json?.decision === 'REFUSE', S, rail, 'wrong payee: the co-signer REFUSES the transfer to the wrong recipient', `REFUSE (${dry.json?.reason}); dry run on the really Reserved payable, nothing sent`, `HTTP ${dry.status} decision ${dry.json?.decision} ${dry.json?.reason}`);
    // 2. the gate is bypassed on purpose (we hold the payer key): the chain cannot inspect a PLT transfer
    const wrongTx = await transfer(id, view, wrongPayee);
    const cf = await send(sig.sellerB, 'confirm_plt', v2enc.encodeV2Confirm({ seller: S1, id, txHashHex: wrongTx }));
    const after = await getPayable(c, S1, id);
    row(S, rail, 'wrong payee: gate bypassed (payer key used directly)', 'INFO', `the registry ${cf.reject ? 'REFUSED' : 'accepted'} confirm_plt (${cf.reject?.name ?? 'accepted'}); status ${after.status}. A registry contract cannot read a PLT transfer, so on Rail B the wrong-payee guard is the co-signer plus the after-pay verifier, not a contract revert.`, { register_tx: reg.txHash, reserve_tx: rs.txHash, wrong_transfer_tx: wrongTx, confirm_tx: cf.txHash });
    // 3. the independent verifier then flags the payment
    if (after.status === 'Paid') {
      const va = await POST(`/api/payables/${id}/verify`, { mode: 'after_pay', doc_sha256: sha256(Buffer.from(reg.docText)) }, { retries: 3 });
      const failed = (va.json?.checks ?? []).filter((x) => x.status === 'fail').map((x) => x.id);
      check(va.json?.verdict === 'blocked' && failed.includes('to_payee'), S, rail, 'wrong payee: the after-pay verifier (API) flags it', `verdict blocked; failed checks: ${failed.join(', ')}`, `verdict ${va.json?.verdict}; failed ${failed.join(', ')}`);
      const kv = runKeylessVerifier({ id, txHash: wrongTx, docText: reg.docText, rail, seller: S1, reserve: rs.txHash, confirm: cf.txHash });
      check(!kv.ok && /to_payee/.test(kv.out ?? kv.line), S, rail, 'wrong payee: the independent keyless verifier flags it', kv.line, `keyless verifier did not flag to_payee: ${kv.line}`);
    }
  } catch (e) { fail(S, rail, 'wrong payee', redact(e.message)); }

  // ---- D2 stranger confirm ----
  try {
    const id = base + 1;
    const reg = await registerEud(id, 'e2e stranger-confirm payable');
    if (reg.rejected) throw new Error(`register rejected ${reg.rejected.rejectReason}`);
    const rs = await send(sig.sellerB, 'reserve_plt', key(id));
    if (rs.reject) throw new Error(`reserve rejected ${rs.reject.name}`);
    const view = await getPayable(c, S1, id);
    const trTx = await transfer(id, view, conf.PAYEE_EUDEMO);
    const stranger = sig.seller2; // never the reserving payer
    const badC = await send(stranger, 'confirm_plt', v2enc.encodeV2Confirm({ seller: S1, id, txHashHex: trTx }));
    check(badC.reject && badC.reject.code === -17, S, rail, 'stranger confirm: on-chain reject (NotPayer)', `${badC.reject?.name} (${badC.reject?.code}) for a confirm from ${short(stranger.address)}`, `stranger confirm ${badC.reject ? badC.reject.name + ' ' + badC.reject.code : 'ACCEPTED'}`, { register_tx: reg.txHash, reserve_tx: rs.txHash, transfer_tx: trTx, rejected_confirm_tx: badC.txHash });
    const mid = await getPayable(c, S1, id);
    check(mid.status === 'Reserved', S, rail, 'stranger confirm: payable still Reserved', `status ${mid.status}`, `status ${mid.status}`);
    const good = await send(sig.sellerB, 'confirm_plt', v2enc.encodeV2Confirm({ seller: S1, id, txHashHex: trTx }));
    const end = await getPayable(c, S1, id);
    check(!good.reject && end.status === 'Paid', S, rail, 'stranger confirm: the reserving payer then confirms -> Paid', `accepted; status ${end.status}`, `payer confirm ${good.reject?.name ?? 'ok'}; status ${end.status}`, { confirm_tx: good.txHash });
  } catch (e) { fail(S, rail, 'stranger confirm', redact(e.message)); }

  // ---- D3 fraud registration: a stranger registers an invoice under the seller's agent token ----
  try {
    const id = base + 2;
    const dueMs = Date.now() + 3_600_000;
    // sender = the demo payer (holds no agent token), claiming token 1476 (owned by seller 1); payee/expected are other accounts so the refusal is about the TOKEN
    const sent = await sendUpdate(c, { from: sig.sellerB, receiveName: 'register_payable', parameterHex: v2enc.encodeV2RegisterPayable({ id, payee: conf.PAYEE_EUDEMO, amount: '10000', asset: 'EUDemo', dueMs, docHashHex: sha256(Buffer.from('fraud')), token: conf.OWNER_TOKEN, expected: S1, legal: null }), maxEnergy: 6000n });
    const st = await waitFinalized(c, sent.txHash);
    const rr = rejectOf(st);
    const info = rr ? rejectInfo(rr.rejectReason) : null;
    check(!!info, S, rail, 'fraud payable: a stranger cannot register under the seller agent token', `chain rejected the registration: ${info?.name} (${info?.code})`, 'the chain ACCEPTED a stranger registering with the seller token', { rejected_register_tx: sent.txHash });
  } catch (e) { fail(S, rail, 'fraud registration', redact(e.message)); }
}

main().catch((e) => { console.error('E2E aborted:', redact(e?.message ?? e)); process.exit(2); });
