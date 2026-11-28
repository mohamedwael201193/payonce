// PayOnce API — Verification of Payee + sponsored relayer routes.
//   GET  /api/vop/check?seller=&payee=&name=[&country=&buyer=]   check_payee (also POST with JSON)
//   POST /api/vop/proofs        { payee, presentation, version }  keyless verify + store by anchor
//   GET  /api/vop/proofs/:anchor                                  the stored presentation (re-verifiable)
//   GET  /api/vop/payee?seller=&payee=                            the raw payee-book record
//   GET  /api/vop/payable?seller=&id=                             a v3 payable (payee + payee_version from chain)
//   GET  /api/vop/check?network=mainnet&payee=&name=              mainnet mode: identity-only (never MATCH, never payable), see vop-mainnet.mjs
//   GET  /api/census                                              VoP census of the Agent Registry (census_public.json shape)
//   GET  /api/vop/config                                          contract, codes, verdicts
//   GET  /api/demo/run                                            latest fresh /demo run (90 s demo book); starts a new one when >50 min old
//   GET  /api/relay/config                                        what the relayer sponsors
//   POST /api/relay/prepare     { sender, entrypoint, parameter } sponsor-first: tx co-signed by the sponsor, wallet signs + submits
//   POST /api/relay/build       { sender, entrypoint, parameter | kind:'token', recipient, amount, memo }
//   POST /api/relay/submit      { transaction }                   sender-signed -> sponsor co-signs -> submit once
//   GET  /api/check-payee?seller=&payee=&legal_name=               alias of /api/vop/check (+ epc_verdict lower case)
// The MCP / npm / GitHub Action packaging wraps GET /api/vop/check (see the handoff).
import { VerifiablePresentationV1, getEmbeddedModuleSchema } from '@concordium/web-sdk';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createVopService, VopError } from './vop-service.mjs';
import { createRelayer, RelayError } from './relayer.mjs';
import { V3, v3Label, V3_ERRORS, getPayeeRecord, getConfigV3, getPayableV3, accountIdentity } from './vop-chain.mjs';
import { VERDICT, BUSINESS_IDPS } from './vop.mjs';
import { vClient, VERIFIER_URL } from './consent.mjs';
import { signers } from './chain-v2.mjs';
import { kvGet, kvPut, kvList } from './store.mjs';
import { createX402Client, X402Error, X402_POLICY } from './x402-client.mjs';
import { createPayeeCards } from './payee-card.mjs';
import { checkMainnet } from './vop-mainnet.mjs';
import { loadCensus } from './census.mjs';
import { BACKEND_DIR } from './backend.mjs';
import { retryingReads } from './node-retry.mjs';
import { parseInvoice, ParseError } from './invoice-parse.mjs';
import { pathToFileURL } from 'node:url';
import { OWNER_ADDRESS } from './config.mjs';

const toPlain = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));

export async function verifyPresentationKeyless({ version, presentation }) {
  if (version === 'v0') {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30_000);
    try {
      const r = await fetch(VERIFIER_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(presentation), signal: ctl.signal });
      return r.ok ? { ok: true } : { ok: false, reason: `verifier HTTP ${r.status}` };
    } catch (e) { return { ok: false, reason: `verifier unreachable (${String(e?.message ?? e).slice(0, 80)})` }; } finally { clearTimeout(t); }
  }
  let pres;
  try { pres = VerifiablePresentationV1.fromJSON(presentation); } catch (e) { return { ok: false, reason: `malformed V1 presentation (${String(e?.message ?? e).slice(0, 80)})` }; }
  // The public node rate-limits (HTTP 429 / UNAVAILABLE): that is "no answer", not "invalid". Retry with backoff.
  let last = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await VerifiablePresentationV1.verifyWithNode(pres, vClient(), 'Testnet');
      if (r?.type === 'success') return { ok: true };
      last = { ok: false, reason: String(r?.error?.message ?? r?.error ?? 'node verification failed').slice(0, 200) };
    } catch (e) { last = { ok: false, reason: String(e?.message ?? e).slice(0, 200) }; }
    if (!/429|UNAVAILABLE|RESOURCE_EXHAUSTED|ECONNRESET|ETIMEDOUT/.test(last.reason)) return last;
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  return { ...last, transient: true };
}

export const vop = createVopService({
  grpc: async () => retryingReads(vClient()), // reads only: retries the public node's 429s
  kv: { get: kvGet, put: kvPut },
  verifyPresentation: verifyPresentationKeyless,
  network: 'Testnet',
});

let schemaB64 = null;
async function moduleSchemaBase64() {
  if (schemaB64) return schemaB64;
  const v = readFileSync(new URL('../../contracts/payable_registry_v3/verifiable/payable_registry_v3.wasm.v1', import.meta.url));
  const raw = await getEmbeddedModuleSchema({ version: 1, source: new Uint8Array(v.subarray(8)) });
  schemaB64 = raw ? Buffer.from(raw.buffer ?? raw).toString('base64') : null;
  return schemaB64;
}

export const relayer = createRelayer({
  grpc: async () => vClient(),
  sponsor: async () => (await signers()).owner,
  hitWindow: (key, windowMs, limit) => hitWindowRef(key, windowMs, limit),
  moduleSchemaBase64,
});
let hitWindowRef = async () => ({ allowed: true });

// ---- x402 buyer (VoP on every payTo) and payee links ----
const BOOK_SELLERS = (process.env.PAYONCE_BOOK_SELLERS ?? OWNER_ADDRESS).split(',').map((x) => x.trim()).filter(Boolean);
const APP_BASE = process.env.PAYONCE_APP_URL ?? 'https://payonce-tau.vercel.app';
const API_BASE = process.env.PAYONCE_API_URL ?? 'https://payonce-api-n98a.onrender.com';

/** Sellers built by other teams that answer a real x402 402 on Concordium testnet (tiny prices). Purchases are recorded. */
export const X402_SELLERS = [
  { id: 'oracle-scout', name: 'Oracle Scout', team: 'Oracle Scout (agent #1253)', url: 'https://web-gilt-phi-11.vercel.app/api/packs/rehearsal-btc-150k', method: 'GET', price_ccd: '2', price_display: '2 CCD', pay_to: '3u319bYkSSU3CeoMqyzt5nd72VpL5qF4oqmZoVTQQPLdBEqyL1', needs_age: false, note: 'Evidence pack for a prediction market.' },
  { id: 'mainsmarker', name: 'MainsMarker', team: 'MainsMarker (agent #990)', url: 'https://mainsmarker.sites.tab.bot/x402/review', method: 'POST', body: { question: 'Explain why the sky appears blue during the day.', answer: 'Sunlight is scattered by air molecules, and short blue wavelengths scatter far more than red ones (Rayleigh scattering), so blue light reaches us from every direction.', marks: 10, mode: 'cloud' }, price_ccd: '0.5', price_display: '0.5 CCD', pay_to: '4J2SFgeVrLHVqPkb3dczpYKP99wFMm7FDFp3fEPwXMff3ieLi2', needs_age: false, note: 'AI answer review.' },
];

async function buildPayload({ requirement, resource }) {
  const mod = await import(pathToFileURL(`${BACKEND_DIR}src/facilitator/client.mjs`).href);
  const { seller2 } = await signers();
  const base = await mod.buildCcdPaymentPayload({ buyer: seller2, requirements: requirement });
  return { x402Version: base.x402Version, resource: resource ?? undefined, accepted: requirement, payload: base.payload };
}

export const x402 = createX402Client({
  checkPayee: (i) => vop.check(i),
  buildPayload,
  record: async (rec) => { await kvPut('x402_purchase', `${rec.at}-${rec.tx_hash ?? 'none'}`.slice(0, 120), rec); },
});

export const cards = createPayeeCards({
  kv: { get: kvGet },
  vop,
  readBook: (seller, payee) => getPayeeRecord(retryingReads(vClient()), seller, payee),
  readAccount: async (a) => { const id = await accountIdentity(retryingReads(vClient()), a); return { exists: !!id?.exists }; },
  bookSellers: BOOK_SELLERS,
  appBase: APP_BASE, apiBase: API_BASE,
});


// ---- /demo: fresh real runs on the 90 s demo book, at most one in flight, at most DEMO_MAX_PER_DAY a day ----
export const DEMO_BOOK = { index: String(process.env.PAYONCE_DEMO_BOOK_INDEX ?? 13173), subindex: '0', cooling_off_secs: 90 };
const DEMO_FRESH_MS = 50 * 60_000;
const DEMO_MAX_PER_DAY = Number(process.env.PAYONCE_DEMO_MAX_PER_DAY ?? 30);
let demoChild = null;
async function demoRun() {
  const latest = await kvGet('demo_run', 'latest');
  const age = latest?.generated_at ? Date.now() - Date.parse(latest.generated_at) : Infinity;
  let refreshing = !!demoChild;
  const lastError = await kvGet('demo_run', 'last_error');
  const lock = await kvGet('demo_run', 'lock');
  const locked = lock?.until_ms > Date.now();
  if (locked) refreshing = true;
  const backoff = lastError?.at && Date.now() - Date.parse(lastError.at) < 15 * 60_000 && (!latest?.generated_at || Date.parse(lastError.at) > Date.parse(latest.generated_at));
  if (!demoChild && !locked && !backoff && age > DEMO_FRESH_MS) {
    const day = new Date().toISOString().slice(0, 10);
    const count = (await kvGet('demo_run', `count:${day}`))?.n ?? 0;
    if (count < DEMO_MAX_PER_DAY) {
      await kvPut('demo_run', `count:${day}`, { n: count + 1 });
      const script = fileURLToPath(new URL('../scripts/demo-run.mjs', import.meta.url));
      demoChild = spawn(process.execPath, [script], { env: { ...process.env, PAYONCE_V3_INDEX: DEMO_BOOK.index, PAYONCE_V3_SUBINDEX: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      demoChild.stderr.on('data', (d) => { err = (err + d).slice(-600); });
      demoChild.on('exit', (code) => { if (code && code !== 3 && !/DEMO_RUN_FAILED/.test(err)) kvPut('demo_run', 'last_error', { at: new Date().toISOString(), step: 'process', error: `exit ${code}: ${err.slice(-300)}` }).catch(() => {}); demoChild = null; });
      refreshing = true;
    }
  }
  const last_error = lastError && (!latest?.generated_at || Date.parse(lastError.at) > Date.parse(latest.generated_at)) ? { at: lastError.at, step: lastError.step, error: lastError.error } : undefined;
  if (!latest) return { live: false, refreshing, label: refreshing ? 'No fresh run yet; one is being produced (about 3 minutes).' : 'No fresh run available right now.', last_error, demo_book: DEMO_BOOK };
  return { ...latest, live: age <= 3_600_000 && latest.live === true, refreshing, age_secs: Math.round(age / 1000), last_error, demo_book: DEMO_BOOK };
}

/** network=mainnet -> identity-only mainnet mode; anything else -> the testnet v3 check. */
const isMainnet = (v) => String(v ?? '').toLowerCase() === 'mainnet';
const runCheck = (input) => (isMainnet(input?.network) ? checkMainnet(input) : vop.check(input));

export function vopRoutes({ sendJson, apiError, readBody, clientIp, hitWindow }) {
  hitWindowRef = hitWindow;
  const wrap = (fn) => async (req, res, m) => {
    try {
      return sendJson(res, 200, toPlain(await fn(req, res, m)));
    } catch (e) {
      if (e instanceof ParseError) return apiError(res, 400, e.code, 'app', e.message);
      if (e instanceof X402Error) return apiError(res, e.status, e.code, 'app', e.message);
      if (e instanceof VopError || e instanceof RelayError) return apiError(res, e.status, e.code, 'app', e.message);
      if (/body too large|invalid JSON/.test(e?.message ?? '')) return apiError(res, 400, 'bad_request', 'app', e.message);
      return apiError(res, 502, 'vop_upstream', 'node', `The chain did not answer (${String(e?.message ?? e).slice(0, 200)}).`, { retryable: true });
    }
  };
  const limited = (key, perMin) => async (req) => {
    const w = await hitWindow(`${key}:${clientIp(req)}`, 60_000, perMin);
    if (!w.allowed) throw new VopError(429, 'rate_limited', 'Too many requests, slow down.');
  };
  const qs = (req) => Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const relayLimited = async (req) => {
    const w = await hitWindow(`relay:${clientIp(req)}`, 60_000, 12);
    if (!w.allowed) throw new RelayError(429, 'rate_limited', 'Too many relay requests, slow down.');
  };
  return [
    ['GET', /^\/api\/vop\/config$/, wrap(async () => ({
      contract: { address: v3Label(), name: V3.name, module_ref: V3.moduleRef, config: await getConfigV3(vClient()).catch(() => null) },
      verdicts: Object.values(VERDICT), business_identity_providers: BUSINESS_IDPS, reject_codes: V3_ERRORS,
      networks: { testnet: 'full check: payee book v3 + proof (default)', mainnet: 'identity-only: add network=mainnet; never MATCH, never payable (no mainnet payee book yet)' },
      check: 'GET /api/vop/check?seller=<acct>&payee=<acct>&name=<invoice payee name>[&buyer=<acct>][&network=mainnet]',
      rule: 'An agent pays only when payable=true: verdict MATCH, payee bound by its own signature, cooling-off over, proof anchored and re-verified with the node.',
    }))],
    ['GET', /^\/api\/vop\/check$/, wrap(async (req) => { await limited('vop:check', 30)(req); const q = qs(req); return runCheck({ network: q.network, seller: q.seller, payee: q.payee, legal_name: q.name ?? q.legal_name, country: q.country, buyer: q.buyer }); })],
    // Alias for the interface the MCP / npm / GitHub Action packaging codes against (handoff V11): same service,
    // EPC lower-case vocabulary added as `epc_verdict`.
    ['GET', /^\/api\/check-payee$/, wrap(async (req) => { await limited('vop:check', 30)(req); const q = qs(req); const r = await runCheck({ network: q.network, seller: q.seller, payee: q.payee, legal_name: q.legal_name ?? q.name, country: q.country, buyer: q.buyer }); return { ...r, epc_verdict: r.verdict.toLowerCase() }; })],
    ['POST', /^\/api\/vop\/check$/, wrap(async (req) => { await limited('vop:check', 30)(req); return runCheck(await readBody(req)); })],
    ['POST', /^\/api\/vop\/proofs$/, wrap(async (req) => { await limited('vop:proof', 6)(req); return vop.submitProof(await readBody(req, 256 * 1024)); })],
    ['GET', /^\/api\/vop\/proofs\/([0-9a-f]{64})$/, wrap(async (req, res, m) => { await limited('vop:proofget', 30)(req); return vop.getProof(m[1]); })],
    ['GET', /^\/api\/vop\/payee$/, wrap(async (req) => {
      await limited('vop:payee', 30)(req); const q = qs(req);
      if (!/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(q.seller ?? '') || !/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(q.payee ?? '')) throw new VopError(400, 'bad_address', 'seller and payee are account addresses.');
      return { contract: v3Label(), record: await getPayeeRecord(vClient(), q.seller, q.payee) };
    })],
    ['GET', /^\/api\/vop\/payable$/, wrap(async (req) => {
      await limited('vop:payable', 60)(req); const q = qs(req);
      if (!/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(q.seller ?? '') || !/^\d{1,19}$/.test(q.id ?? '')) throw new VopError(400, 'bad_key', 'seller (account) and id (integer) are required.');
      return { contract: v3Label(), payable: await getPayableV3(vClient(), q.seller, q.id) };
    })],
    ['GET', /^\/api\/census$/, wrap(async (req) => { await limited('census', 60)(req); return loadCensus(); })],
    // ---- x402 buyer with check_payee on every payTo ----
    ['GET', /^\/api\/x402\/sellers$/, wrap(async () => ({ sellers: X402_SELLERS, policy: { network: 'Concordium testnet', max_ccd_per_purchase: '2.5', asset: 'CCD', payer: 'PayOnce reference buyer agent (labelled; a person approves anything that is not a Match)', outcomes: ['match: pay once', 'close_match: a person decides', 'no_match: pay nothing', 'not_possible: a person decides'] } }))],
    ['GET', /^\/api\/x402\/probe$/, wrap(async (req) => { await limited('x402:probe', 12)(req); const q = qs(req); return x402.probe({ url: q.url, method: q.method, name: q.name }); })],
    ['POST', /^\/api\/x402\/probe$/, wrap(async (req) => { await limited('x402:probe', 12)(req); return x402.probe(await readBody(req, 16 * 1024)); })],
    ['POST', /^\/api\/x402\/buy$/, wrap(async (req) => {
      const w = await hitWindow(`x402buy:${clientIp(req)}`, 3_600_000, X402_POLICY.perIpPerHour);
      const d = await hitWindow('x402buy:day', 86_400_000, X402_POLICY.perDay);
      if (!w.allowed || !d.allowed) throw new VopError(429, 'rate_limited', 'Purchase limit reached (a few per hour per visitor, a small daily total). Try the probe, which is free, or come back later.');
      const body = await readBody(req, 16 * 1024);
      const known = X402_SELLERS.find((s) => s.id === body.seller_id);
      const input = known ? { url: known.url, method: known.method, body: known.body, name: body.name ?? known.name, approved: body.approved === true } : { url: body.url, method: body.method, body: body.body, name: body.name, approved: body.approved === true };
      return x402.buy({ ...input, buyer: 'payonce_reference_buyer' });
    })],
    ['GET', /^\/api\/x402\/purchases$/, wrap(async () => { const rows = (await kvList('x402_purchase')).map((r) => r.value).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50); return { count: rows.length, purchases: rows }; })],
    ['POST', /^\/api\/invoices\/parse$/, wrap(async (req) => { await limited('invoice:parse', 30)(req); const b = await readBody(req, 64 * 1024); return parseInvoice(b?.text); })],
    // ---- payee links ----
    ['GET', /^\/api\/p\/([1-9A-HJ-NP-Za-km-z]{50})$/, wrap(async (req, res, m) => { await limited('p:card', 60)(req); return cards.card(m[1]); })],
    ['GET', /^\/api\/p\/([1-9A-HJ-NP-Za-km-z]{50})\/check$/, wrap(async (req, res, m) => { await limited('vop:check', 30)(req); const q = qs(req); return cards.check(m[1], q.name ?? q.legal_name, { country: q.country, buyer: q.buyer }); })],
    ['GET', /^\/api\/demo\/run$/, wrap(async (req) => { await limited('demo:run', 30)(req); return demoRun(); })],
    ['GET', /^\/api\/relay\/config$/, wrap(() => relayer.config())],
    ['POST', /^\/api\/relay\/prepare$/, wrap(async (req) => { await relayLimited(req); return relayer.prepare(await readBody(req)); })],
    ['POST', /^\/api\/relay\/build$/, wrap(async (req) => { await relayLimited(req); return relayer.build(await readBody(req)); })],
    ['POST', /^\/api\/relay\/submit$/, wrap(async (req) => { await relayLimited(req); return relayer.submit(await readBody(req, 128 * 1024)); })],
  ];
}
