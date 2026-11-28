// PayOnce API — Verification of Payee + sponsored relayer routes.
//   GET  /api/vop/check?seller=&payee=&name=[&country=&buyer=]   check_payee (also POST with JSON)
//   POST /api/vop/proofs        { payee, presentation, version }  keyless verify + store by anchor
//   GET  /api/vop/proofs/:anchor                                  the stored presentation (re-verifiable)
//   GET  /api/vop/payee?seller=&payee=                            the raw payee-book record
//   GET  /api/vop/payable?seller=&id=                             a v3 payable (payee + payee_version from chain)
//   GET  /api/vop/check?network=mainnet&payee=&name=              mainnet mode: identity-only (never MATCH, never payable), see vop-mainnet.mjs
//   GET  /api/census/verify                                       re-reads a sample of census accounts from a node (read-only, cached 30 min, 6/min/IP)
//   POST /api/vop/anchor {payee,name}  GET /api/vop/anchor/<evidence_hash>   verdict receipt: the evidence_hash anchored by registerData (testnet, 3/h/IP, 60/day), see vop-anchor.mjs
//   GET  /api/status                                              public status: api, census freshness, badge continuity, registry, nodes (cached 60 s)
//   GET  /api/census                                              VoP census of the Agent Registry (census_public.json shape)
//   GET  /api/vop/config                                          contract, codes, verdicts
//   GET  /api/x402/check-payee?payee=&name=  PayOnce sells check_payee: 402 -> 0.01 CCD (testnet, fee sponsored) -> verdict; GET /api/x402/sales lists settled sales
//   GET  /api/demo/run                                            latest fresh /demo run (90 s demo book); starts a new one when >50 min old
//   POST /api/vop/proofs/diagnose {presentation, version?, account?}   QA: verify a wallet presentation, holder account, single-credential? (stores nothing)
//   POST /api/approvals/request {payer, payee, name, amount_micro}  -> message for the wallet's signMessage; POST /api/approvals/:id/verify {signature}; GET /api/approvals/:id
//   GET  /api/vop/ledger/head | /api/vop/ledger?from=&limit= | /api/vop/ledger/verify   hash-chained receipts, head anchored (registerData PVOH1)
//   POST /api/payee/propose {account}      GET /api/payee/:account     (dashboard, demo book <13173,0>; dash.mjs)
//   POST /api/getpaid {payee, invoice}     GET /api/getpaid/:job       POST /api/getpaid/:job/redirect {to}
//   GET  /api/badge/:account.svg?name=     embeddable payee-check badge (Match is the only green)
//   GET  /api/p/:account/pay-tx?payer=&amount_micro=[&name=][&asset=eudemo]
//   POST /api/p/:account/plt-confirm { payable_id, tx_hash }          GET /api/record/:account
//   book=demo on /api/vop/check, /api/check-payee, /api/relay/config and in the /api/relay/prepare body selects the demo book
//   GET  /api/relay/config                                        what the relayer sponsors
//   POST /api/relay/prepare     { sender, entrypoint, parameter } sponsor-first: tx co-signed by the sponsor, wallet signs + submits
//   POST /api/relay/build       { sender, entrypoint, parameter | kind:'token', recipient, amount, memo }
//   POST /api/relay/submit      { transaction }                   sender-signed -> sponsor co-signs -> submit once
//   GET  /api/check-payee?seller=&payee=&legal_name=               alias of /api/vop/check (+ epc_verdict lower case)
// The MCP / npm / GitHub Action packaging wraps GET /api/vop/check (see the handoff).
import { VerifiablePresentationV1, AccountAddress as AccountAddressV, getEmbeddedModuleSchema, getUpdateContractParameterSchema, ContractName, EntrypointName } from '@concordium/web-sdk';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createVopService, VopError } from './vop-service.mjs';
import { createRelayer, RelayError } from './relayer.mjs';
import { V3, DEMO_V3, v3Label, V3_ERRORS, getPayeeRecord, getConfigV3, getPayableV3, accountIdentity } from './vop-chain.mjs';
import { createDashboard, DashError } from './dash.mjs';
import { createDashChain } from './dash-chain.mjs';
import { createLedger } from './vop-ledger.mjs';
import { createAttackCatalogue, aliasOf } from './vop-attacks.mjs';
import { createFees } from './fees.mjs';
const fees = createFees();
import { createApprovals, ApprovalError } from './approvals.mjs';
import { sendRegisterData, txStatus } from './vop-anchor-wiring.mjs';
import { VERDICT, BUSINESS_IDPS } from './vop.mjs';
import { vClient, VERIFIER_URL } from './consent.mjs';
import { signers } from './chain-v2.mjs';
import { kvGet, kvPut, kvList } from './store.mjs';
import { createX402Client, X402Error, X402_POLICY } from './x402-client.mjs';
import { createA2A } from './a2a.mjs';
import { createX402Seller, SellerError, TESTNET_CAIP2 as X402_CAIP2 } from './x402-seller.mjs';
import { createPayeeCards } from './payee-card.mjs';
import { badgeKind, badgeSvg } from './badge-svg.mjs';
import { checkMainnet } from './vop-mainnet.mjs';
import { loadCensus } from './census.mjs';
import { loadAndVerify } from './census-verify.mjs';
import { createAnchorService, AnchorError } from './vop-anchor.mjs';
import { createStatus } from './status.mjs';
import { mainnetGrpc } from './vop-mainnet.mjs';
import { BACKEND_DIR } from './backend.mjs';
import { retryingReads } from './node-retry.mjs';
import { parseInvoice, ParseError } from './invoice-parse.mjs';
import { pathToFileURL } from 'node:url';
import { OWNER_ADDRESS, OWNER_TOKEN } from './config.mjs';

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

// ---- the 90 s DEMO book <13173,0>: its own check_payee + relayer + the /app dashboard (dash.mjs) ----
export const vopDemo = createVopService({
  grpc: async () => retryingReads(vClient()), kv: { get: kvGet, put: kvPut }, verifyPresentation: verifyPresentationKeyless, network: 'Testnet', book: DEMO_V3,
});
export const relayerDemo = createRelayer({
  grpc: async () => vClient(), sponsor: async () => (await signers()).owner,
  hitWindow: (key, windowMs, limit) => hitWindowRef(key, windowMs, limit), moduleSchemaBase64, book: DEMO_V3,
});
let payCcdSchemaB64 = null;
async function payCcdSchema() {
  if (payCcdSchemaB64) return payCcdSchemaB64;
  const ms = await moduleSchemaBase64();
  if (!ms) return null;
  payCcdSchemaB64 = Buffer.from(getUpdateContractParameterSchema(Buffer.from(ms, 'base64'), ContractName.fromString(DEMO_V3.name), EntrypointName.fromString('pay_ccd'))).toString('base64');
  return payCcdSchemaB64;
}
// ---- G16 hash-chained receipts (anchored head) + G11 wallet-signed approvals ----
export const ledger = createLedger({ kv: { get: kvGet, put: kvPut, list: kvList }, send: sendRegisterData, status: txStatus });
export const approvals = createApprovals({
  kv: { get: kvGet, put: kvPut }, vop: vopDemo, seller: OWNER_ADDRESS, ledger,
  accountInfo: (a) => vClient().getAccountInfo(AccountAddressV.fromBase58(a)),
  hitWindow: (key, windowMs, limit) => hitWindowRef(key, windowMs, limit),
});
/** Append a check_payee answer to the ledger (testnet only) and anchor the head when due; never blocks the answer. */
function logCheck(r, input) {
  if (!r?.evidence_hash || isMainnet(input?.network)) return r;
  ledger.append({ kind: 'check', book: r.subject?.contract ?? null, seller: r.subject?.seller ?? null, payee: r.subject?.payee ?? null, verdict: r.verdict, payable: !!r.payable, evidence_hash: r.evidence_hash, checked_at: r.checked_at })
    .then(() => ledger.anchorHead()).catch(() => {});
  return r;
}
// ---- G13 live attack catalogue on the demo book (fixtures: api/scripts/attack-fixtures.mjs) ----
const ATTACK_X = '3GPTo1LQbwHcsxPLBmWAVAA4RF6FvbDkzbf7DvLkEKpxWMboHq';
let attackCache = null; let attackRun = null;
function attackCatalogue() {
  return createAttackCatalogue({
    client: () => vClient(), book: DEMO_V3, seller: OWNER_ADDRESS, // the payer named on invoice 123 (registered before the demo buyer moved to the badged agent 1488)
    buyer: '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr', token: BigInt(OWNER_TOKEN),
    moduleRef: '8641046eb939a5693731b6d79b227a1a4b356d8cf10308baabca0a93a16b3946',
    fixtures: {
      X: ATTACK_X, Y: aliasOf(ATTACK_X, 1), stranger: '3LgPU9K2WFg3ghFHXjm2r2Mizi2eqY71ENTWqHZL98h9ueFKMt', staleInvoice: 123, paidInvoice: 122, openInvoice: 777000001,
      recorded: { notMature: '6bfe195c14a8d82295b4a127fb3ab634a27761ce92f7f12aee063b9ff0654ced', payTwice: 'd91e7611d894d88092d600e97c83e3c9c08cc9d94a8ca0e423348b92f9ccb021' },
    },
    check: (input) => vopDemo.check(input), payTx: async (payee, q, ip) => (await dashboard()).payTx(payee, q, ip), approvals,
  });
}
async function attackScorecard(fresh) {
  if (!fresh && attackCache && Date.now() - attackCache.at < 10 * 60_000) return attackCache.value;
  if (!fresh && !attackCache) { const k = await kvGet('proof', 'attacks:latest').catch(() => null); if (k && Date.now() - Date.parse(k.generated_at) < 10 * 60_000) { attackCache = { at: Date.parse(k.generated_at), value: k }; return k; } }
  attackRun ??= attackCatalogue().run().then(async (v) => { attackCache = { at: Date.now(), value: v }; await kvPut('proof', 'attacks:latest', v).catch(() => {}); return v; }).finally(() => { attackRun = null; });
  return attackRun;
}
const dashDeps = {
  kv: { get: kvGet, put: kvPut, list: kvList },
  hitWindow: (key, windowMs, limit) => hitWindowRef(key, windowMs, limit),
  vop: vopDemo, seller: OWNER_ADDRESS, payer: null, agentToken: OWNER_TOKEN, book: DEMO_V3, bookLabel: v3Label(DEMO_V3),
  appBase: process.env.PAYONCE_APP_URL ?? 'https://payonce-tau.vercel.app',
  chain: createDashChain({ client: () => vClient(), signers, book: DEMO_V3, seller: OWNER_ADDRESS }),
  ledger, approvals,
};
let dashboardP = null;
/** Lazily built: the payer address and the pay_ccd schema load after boot. */
export function dashboard() {
  if (!dashboardP) {
    dashboardP = (async () => {
      const s = await signers();
      return createDashboard({ ...dashDeps, payer: s.seller2.address, payCcdSchema: await payCcdSchema() });
    })().catch((e) => { dashboardP = null; throw e; });
  }
  return dashboardP;
}
const isDemoBook = (v) => String(v ?? '').toLowerCase() === 'demo' || String(v ?? '') === String(DEMO_V3.index);

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
  checkPayee: (i) => runCheck(i),
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
const runCheck = async (input) => (isMainnet(input?.network) ? checkMainnet(input) : logCheck(await (isDemoBook(input?.book) ? vopDemo.check(input) : vop.check(input)), input));

const nodeProbe = (getClient) => async () => { const c = await getClient(); const s = await c.getConsensusStatus(); return { detail: `finalized height ${String(s.lastFinalizedBlockHeight)}` }; };
const statusFn = createStatus({ loadCensus, testnetNode: nodeProbe(async () => vClient()), mainnetNode: nodeProbe(async () => mainnetGrpc()) });
// ---- PayOnce sells its own check over x402 (paid check_payee, 0.01 CCD, testnet, fee sponsored by PayOnce) ----
const sellerSeen = new Set();
let facilitatorP = null;
const ownFacilitator = () => (facilitatorP ??= (async () => {
  // @x402/concordium is a dependency of backend/, so the facilitator is built there (same module as the PayOnce Rail A facilitator).
  const { BACKEND_DIR } = await import('./backend.mjs');
  const { pathToFileURL } = await import('node:url');
  const { createFacilitator } = await import(pathToFileURL(`${BACKEND_DIR}src/facilitator/scheme.mjs`).href);
  const { owner } = await signers();
  const f = createFacilitator({ sponsorAddress: owner.address, sponsorSigner: owner.signer });
  return { verify: (p, r) => f.scheme.verify(p, r), settle: (p, r) => f.scheme.settle(p, r) };
})().catch((e) => { facilitatorP = null; throw e; }));
const sellerBase = () => process.env.PAYONCE_PUBLIC_API ?? 'https://payonce-api-n98a.onrender.com';
export const x402Seller = createX402Seller({
  facilitator: { verify: async (p, r) => (await ownFacilitator()).verify(p, r), settle: async (p, r) => (await ownFacilitator()).settle(p, r) },
  check: (i) => runCheck(i), payTo: OWNER_ADDRESS, feePayer: OWNER_ADDRESS, seen: sellerSeen,
  resourceUrl: (q) => `${sellerBase()}/api/x402/check-payee?${new URLSearchParams({ payee: String(q.payee ?? ''), name: String(q.name ?? q.legal_name ?? '') })}`,
  record: async (rec) => { await kvPut('x402_sale', `${rec.at}-${rec.tx_hash}`.slice(0, 120), rec); },
});

const a2a = createA2A({ check: (i) => runCheck(i) });

async function badgeFor(account, q) {
  const name = String(q?.name ?? q?.legal_name ?? '').trim();
  if (name) {
    const r = await cards.check(account, name);
    return badgeSvg(badgeKind({ verdict: r.verdict, payable: r.payable }));
  }
  const c = await cards.card(account);
  return badgeSvg(badgeKind({ verified: c.verified, named: Boolean(c.name) }));
}

export function vopRoutes({ sendJson, apiError, readBody, clientIp, hitWindow }) {
  hitWindowRef = hitWindow;
  let anchorP = null;
  const anchorSvc = () => (anchorP ??= import('./vop-anchor-wiring.mjs').then(({ anchorDeps }) => createAnchorService({ check: (i) => runCheck(i), ...anchorDeps(hitWindow) })).catch((e) => { anchorP = null; throw e; }));
  const wrap = (fn) => async (req, res, m) => {
    try {
      return sendJson(res, 200, toPlain(await fn(req, res, m)));
    } catch (e) {
      if (e instanceof ParseError) return apiError(res, 400, e.code, 'app', e.message);
      if (e instanceof X402Error) return apiError(res, e.status, e.code, 'app', e.message);
      if (e instanceof AnchorError) return apiError(res, e.status, e.code, 'app', e.message, { retryable: e.retryable === true, ...(e.retry_after_s ? { retry_after_s: e.retry_after_s } : {}), ...(e.evidence_hash ? { evidence_hash: e.evidence_hash } : {}) });
      if (e instanceof VopError || e instanceof RelayError) return apiError(res, e.status, e.code, 'app', e.message);
      if (e instanceof DashError || e instanceof ApprovalError) return apiError(res, e.status, e.code, 'app', e.message, e.extra);
      if (/body too large|invalid JSON/.test(e?.message ?? '')) return apiError(res, 400, 'bad_request', 'app', e.message);
      return apiError(res, 502, 'vop_upstream', 'node', `The chain did not answer (${String(e?.message ?? e).slice(0, 200)}).`, { retryable: true });
    }
  };
  const wrapSvg = (fn) => async (req, res, m) => {
    const send = (status, svg) => {
      res.statusCode = status;
      res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
      res.setHeader('cache-control', 'public, max-age=60');
      res.setHeader('access-control-allow-origin', '*');
      res.end(svg);
    };
    try {
      send(200, await fn(req, m));
    } catch (e) {
      // An <img> cannot show JSON: always return a badge, even on a bad address or a node error.
      const status = (e instanceof VopError && e.status) || 502;
      send(status >= 500 ? 502 : status, badgeSvg('UNVERIFIED'));
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
    ['GET', /^\/api\/vop\/check$/, wrap(async (req) => { await limited('vop:check', 30)(req); const q = qs(req); return runCheck({ network: q.network, book: q.book, seller: q.seller, payee: q.payee, legal_name: q.name ?? q.legal_name, country: q.country, buyer: q.buyer }); })],
    // Alias for the interface the MCP / npm / GitHub Action packaging codes against (handoff V11): same service,
    // EPC lower-case vocabulary added as `epc_verdict`.
    ['GET', /^\/api\/check-payee$/, wrap(async (req) => { await limited('vop:check', 30)(req); const q = qs(req); const r = await runCheck({ network: q.network, book: q.book, seller: q.seller, payee: q.payee, legal_name: q.legal_name ?? q.name, country: q.country, buyer: q.buyer }); return { ...r, epc_verdict: r.verdict.toLowerCase() }; })],
    ['POST', /^\/api\/vop\/check$/, wrap(async (req) => { await limited('vop:check', 30)(req); return runCheck(await readBody(req)); })],
    ['POST', /^\/api\/vop\/proofs$/, wrap(async (req) => { await limited('vop:proof', 6)(req); return vop.submitProof(await readBody(req, 256 * 1024)); })],
    ['POST', /^\/api\/vop\/proofs\/diagnose$/, wrap(async (req) => { await limited('vop:diagnose', 6)(req); return vop.diagnose(await readBody(req, 256 * 1024)); })],
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
    ['GET', /^\/api\/census\/verify$/, wrap(async (req) => { await limited('census:verify', 6)(req); return loadAndVerify({ readLocal: (f) => readFileSync(new URL(`../../tools/census/${f}`, import.meta.url), 'utf8') }); })],
    ['GET', /^\/api\/status$/, wrap(async (req) => { await limited('status', 60)(req); return statusFn(); })],
    // ---- verdict receipts: the evidence_hash anchored on chain (testnet registerData) ----
    ['POST', /^\/api\/vop\/anchor$/, wrap(async (req) => { await limited('vop:anchor:req', 12)(req); const b = await readBody(req); const svc = await anchorSvc(); return svc.anchor({ seller: b.seller ?? b.payee, payee: b.payee, legal_name: b.legal_name ?? b.name, country: b.country, network: b.network }, { ip: clientIp(req) }); })],
    ['GET', /^\/api\/vop\/anchor\/([0-9a-fA-F]{64})$/, wrap(async (req, res, m) => { await limited('vop:anchor:get', 60)(req); return (await anchorSvc()).get(m[1]); })],
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
    ['POST', /^\/a2a$/, async (req, res) => {
      try {
        await limited('a2a', 30)(req);
        let body; try { body = await readBody(req, 64 * 1024); } catch { return sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not JSON.' } }); }
        return sendJson(res, 200, toPlain(await a2a.handle(body)));
      } catch (e) {
        if (e instanceof VopError) return apiError(res, e.status, e.code, 'app', e.message);
        return sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'The check could not run. Nothing was paid.' } });
      }
    }],
    ['GET', /^\/a2a$/, wrap(async () => ({ protocol: 'A2A JSON-RPC 2.0', method: 'message/send', card: 'https://payonce-tau.vercel.app/.well-known/agent.json', example: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { payee: '<account>', name: '<payee name on the invoice>' } }] } } }, note: 'Free and read-only. Nothing is paid.' }))],
    ['GET', /^\/api\/x402\/check-payee$/, async (req, res) => {
      try {
        const paid = Boolean(req.headers['payment-signature'] ?? req.headers['x-payment']);
        await limited('x402:sell', 30)(req);
        if (paid) { const d = await hitWindow('x402sell:day', 86_400_000, 40); if (!d.allowed) throw new VopError(429, 'rate_limited', 'PayOnce sells a small number of sponsored checks per day on testnet. Try again tomorrow, or use the free /api/check-payee.'); }
        const r = await x402Seller.handle({ query: qs(req), headers: req.headers });
        for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
        res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE');
        return sendJson(res, r.status, toPlain(r.body));
      } catch (e) {
        if (e instanceof SellerError) return apiError(res, e.status, e.code, 'app', e.message);
        if (e instanceof VopError) return apiError(res, e.status, e.code, 'app', e.message);
        return apiError(res, 502, 'x402_seller_upstream', 'node', `Could not complete the paid check (${String(e?.message ?? e).slice(0, 200)}). Nothing is charged unless a payment settled.`, { retryable: true });
      }
    }],
    ['GET', /^\/api\/x402\/sales$/, wrap(async () => { const rows = (await kvList('x402_sale')).map((r) => r.value).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50); return { count: rows.length, price_ccd: '0.01', pay_to: OWNER_ADDRESS, sales: rows }; })],
    ['GET', /^\/api\/x402\/purchases$/, wrap(async () => { const rows = (await kvList('x402_purchase')).map((r) => r.value).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50); return { count: rows.length, purchases: rows }; })],
    ['POST', /^\/api\/invoices\/parse$/, wrap(async (req) => { await limited('invoice:parse', 30)(req); const b = await readBody(req, 64 * 1024); return parseInvoice(b?.text); })],
    // ---- payee links ----
    ['GET', /^\/api\/p\/([1-9A-HJ-NP-Za-km-z]{50})$/, wrap(async (req, res, m) => { await limited('p:card', 60)(req); return cards.card(m[1]); })],
    ['GET', /^\/api\/p\/([1-9A-HJ-NP-Za-km-z]{50})\/check$/, wrap(async (req, res, m) => { await limited('vop:check', 30)(req); const q = qs(req); return cards.check(m[1], q.name ?? q.legal_name, { country: q.country, buyer: q.buyer }); })],
    ['GET', /^\/api\/badge\/([1-9A-HJ-NP-Za-km-z]{50})(?:\.svg)?$/, wrapSvg(async (req, m) => { await limited('p:badge', 60)(req); return badgeFor(m[1], qs(req)); })],
    ['GET', /^\/api\/p\/([1-9A-HJ-NP-Za-km-z]{50})\/badge\.svg$/, wrapSvg(async (req, m) => { await limited('p:badge', 60)(req); return badgeFor(m[1], qs(req)); })],
    ['GET', /^\/api\/demo\/run$/, wrap(async (req) => { await limited('demo:run', 30)(req); return demoRun(); })],
    ['GET', /^\/api\/relay\/config$/, wrap((req) => (isDemoBook(qs(req).book) ? relayerDemo : relayer).config())],
    ['POST', /^\/api\/relay\/prepare$/, wrap(async (req) => { await relayLimited(req); const b = await readBody(req); return (isDemoBook(b?.book) ? relayerDemo : relayer).prepare(b); })],
    // ---- G19 fees: measured NRG x the chain's live exchange-rate parameters ----
    ['GET', /^\/api\/fees$/, wrap(async (req) => { await limited('fees', 60)(req); return fees.table(); })],
    // ---- G13 live attack catalogue ----
    ['GET', /^\/api\/proof\/attacks$/, wrap(async (req) => { const fresh = qs(req).fresh === '1'; await limited(fresh ? 'attacks:fresh' : 'attacks:get', fresh ? 2 : 60)(req); return attackScorecard(fresh); })],
    ['GET', /^\/api\/proof\/false-green$/, wrap(async (req) => { await limited('falsegreen:get', 30)(req); const r = await kvGet('proof', 'false_green:latest'); if (!r) throw new DashError(404, 'not_run', 'The benchmark has not been run yet (api/scripts/false-green.mjs).'); return qs(req).cases === '1' ? r : { ...r, cases: undefined, cases_url: '/api/proof/false-green?cases=1' }; })],
    // ---- G11 wallet-signed approvals ----
    ['POST', /^\/api\/approvals\/request$/, wrap(async (req) => { await limited('approval:req', 6)(req); return approvals.request(await readBody(req, 8192), clientIp(req)); })],
    ['POST', /^\/api\/approvals\/([0-9a-f]{24})\/verify$/, wrap(async (req, res, m) => { await limited('approval:verify', 12)(req); return approvals.verify(m[1], await readBody(req, 8192)); })],
    ['GET', /^\/api\/approvals\/([0-9a-f]{24})$/, wrap(async (req, res, m) => { await limited('approval:get', 60)(req); return approvals.get(m[1]); })],
    // ---- G16 hash-chained receipts ----
    ['GET', /^\/api\/vop\/ledger\/head$/, wrap(async (req) => { await limited('ledger:head', 60)(req); ledger.anchorHead().catch(() => {}); return ledger.status(); })],
    ['GET', /^\/api\/vop\/ledger\/verify$/, wrap(async (req) => { await limited('ledger:verify', 4)(req); return ledger.verify(); })],
    ['GET', /^\/api\/vop\/ledger$/, wrap(async (req) => { await limited('ledger:list', 30)(req); const q = qs(req); return { entries: await ledger.entries({ from: q.from, limit: q.limit }) }; })],
    // ---- /app dashboard on the demo book (dash.mjs) ----
    ['POST', /^\/api\/payee\/propose$/, wrap(async (req) => { await limited('dash:propose', 6)(req); return (await dashboard()).propose(await readBody(req, 4096), clientIp(req)); })],
    ['GET', /^\/api\/payee\/([1-9A-HJ-NP-Za-km-z]{50})$/, wrap(async (req, res, m) => { await limited('dash:payee', 60)(req); return (await dashboard()).payeeStatus(m[1]); })],
    ['POST', /^\/api\/getpaid$/, wrap(async (req) => { await limited('dash:getpaid', 6)(req); return (await dashboard()).startGetPaid(await readBody(req, 16 * 1024), clientIp(req)); })],
    ['GET', /^\/api\/getpaid\/([0-9a-f]{24})$/, wrap(async (req, res, m) => { await limited('dash:job', 90)(req); return (await dashboard()).getJob(m[1]); })],
    ['POST', /^\/api\/getpaid\/([0-9a-f]{24})\/redirect$/, wrap(async (req, res, m) => { await limited('dash:redirect', 6)(req); return (await dashboard()).redirect(m[1], await readBody(req, 4096), clientIp(req)); })],
    ['GET', /^\/api\/p\/([1-9A-HJ-NP-Za-km-z]{50})\/pay-tx$/, wrap(async (req, res, m) => { await limited('dash:paytx', 12)(req); return (await dashboard()).payTx(m[1], qs(req), clientIp(req)); })],
    ['POST', /^\/api\/p\/([1-9A-HJ-NP-Za-km-z]{50})\/plt-confirm$/, wrap(async (req, res, m) => { await limited('dash:paytx', 12)(req); return (await dashboard()).pltConfirm(m[1], await readBody(req, 4096)); })],
    ['GET', /^\/api\/record\/([1-9A-HJ-NP-Za-km-z]{50})$/, wrap(async (req, res, m) => { await limited('dash:record', 30)(req); return (await dashboard()).record(m[1]); })],
    ['POST', /^\/api\/relay\/build$/, wrap(async (req) => { await relayLimited(req); return relayer.build(await readBody(req)); })],
    ['POST', /^\/api\/relay\/submit$/, wrap(async (req) => { await relayLimited(req); return relayer.submit(await readBody(req, 128 * 1024)); })],
  ];
}
