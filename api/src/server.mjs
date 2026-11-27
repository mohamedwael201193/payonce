// PayOnce API server — P3 §16 HTTP layer (testnet only).
// Node's built-in http only (no framework, same style as the backend's
// facilitator/co-signer servers). Every endpoint returns REAL live data
// read from the testnet just now, or a real refusal with the real code —
// no mocks, no sample numbers (Gate G0 #8). Errors use the P3 §16.1
// envelope under an `error` key. Nothing here returns a key, a seed or
// an .env value. Signers load lazily, in-process only, on the first send
// (POST /api/payables, POST /payables/:id/pay, live attacks); every
// read-only endpoint works without them.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { CredentialRegistrationId } from '@concordium/web-sdk';
import { backend } from './backend.mjs';
import {
  grpc, chainNow, getPayable, getPayableOrNull, getConfig as getChainConfig,
  getVendor, getAccount, getTx, getRegistryBalance, getBlockTime, microCcdOf,
  sendUpdate, waitFinalized, signers, updatedEvent, SELLER, SELLER2, PAYER,
} from './chain-v2.mjs';
import { verifyBeforePay, verifyCcdV2, verifyPltV2 } from './verifier-v2.mjs';
import { buildSnapshotV2 } from './snapshot-v2.mjs';
import { createOrReturnJob, runJob, subscribeJob, unsubscribeJob, rejectInfo, rejectOf, feeOf } from './jobs.mjs';
import { attackPayTwice, attackWrongAmount, attackUnlistedSeller } from './attacks.mjs';
import { buildReceiptFor, paymentTxsFor } from './receipts.mjs';
import {
  docForPayable, docForPayableForSeller, generateLabDocument, storeDocument, recordedRunFor,
  recordedRefusals, judgeFiles,
} from './docs.mjs';
import {
  loadJobs, loadCounters, updateCounters,
  hitWindow, leftInWindow, loadConsents, loadBuyerAgent,
} from './store.mjs';
import {
  buildConsentRecord, consentFor, consentForSeller, consentGateCheck, publicConsent, anchorConsentVra,
  verifyConsentVra, approveConsentHeadless, isConsentExpired, isAboveAskMeThreshold,
  ASK_ME_THRESHOLD_BASE, CONSENT_VALIDITY_SECS, CONSENT_DOMAIN, LAB_CONSENT_ANCHORS,
  LAB_VA_ANCHORS, verifyV1PresentationWithNode, anchorConsentVaa,
  extractPresentationNonce, assertPresentationNonceMatches,
} from './consent.mjs';
import { mcpToolsList, mcpCheckBadge, mcpAgentOf, mcpAgentsByOwner, MCP_URL } from './mcp-client.mjs';
import { checkBalances, topUpPayer, BALANCE_OK_MICROCCD } from './balance-watch.mjs';
import { registerBuyerAgent, merchantCheckBuyer, buyerAgent, BUYER_ACCOUNT } from './buyer-agent.mjs';
import { requestCis8Binding, CIS8_CONTRACT, CIS8_SELLER_TOKEN, externalKeyFromEnv } from './cis8.mjs';
import { VerifiablePresentationV1 } from '@concordium/web-sdk';
import { initStore } from './db.mjs';
import { listableRows, scanIsComplete, statsBody } from './listable.mjs';
import { reconcile } from './reconcile.mjs';
import { registerWithFreshId, foldDiscoveredIds } from './fresh-id.mjs';
import { ledgerForDecide } from './ledger.mjs';
import {
  createAgeProofHandlers, ageGateCheck,
} from './age-proof.mjs';
import {
  REGISTRY, CIS8004_OFFICIAL, RESERVATION_SECS, CO_SIGNER_MARGIN_SECS,
  OWNER_TOKEN, OWNER_ADDRESS, PAYER_ADDRESS, PAYEE_CCD, PAYEE_EUDEMO,
  SELLER2_ADDRESS, SELLER2_TOKEN, SELLER2_BADGE, SELLER2_AGENT_CARD_URL, SELLER2_FRESH_ID_START,
  FRESH_CCD_MICRO, FRESH_EUDEMO_BASE, FRESH_DUE_HOURS, FRESH_ID_START,
  LIMITS, PORT, HOST, NETWORK, EXPLORER_TX, EXPLORER_INSTANCE,
  txUrl, instanceUrl, fmtCcd, fmtEudemo, shortHash, ENV,
} from './config.mjs';

// ---- process guard (fix-back-2, M5 CRITICAL): no single request may kill
// the API. The SDK's createChecked calls compareContexts WITHOUT await; a
// mismatch throw inside it becomes an unhandled promise rejection, which
// Node turns into a process exit — that is how one cross-payable replay
// POST (a valid presentation for payable 2000 submitted to payable 1066)
// killed the server twice on the identical input. The mismatch is now
// pre-filtered (Nonce check in handleConsentVerifyPresentation +
// assertContextsMatch in anchorConsentVaa), but this guard is the last
// line: log the rejection and keep serving instead of dying.
process.on('unhandledRejection', (reason) => {
  console.error('[api] unhandledRejection (server kept alive):', String(reason?.message ?? reason).slice(0, 500));
});

// ---- startup readiness: migrate + seed + reconcile once, before serving.
// The listen block awaits it (fail fast on a dead DB); the request handler
// awaits it too, so the test-import path (server.listen without the main
// block) gets the same guarantee. Reconcile never throws — a recovery
// failure is logged and reported in its summary, never a 500.
let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await initStore();
      if (process.env.PAYONCE_SKIP_RECONCILE === '1') {
        console.log('[startup] reconcile skipped (PAYONCE_SKIP_RECONCILE=1, local testing)');
      } else {
        const summary = await reconcile();
        console.log(`[startup] reconcile: ${summary.line}`);
      }
    })();
  }
  return readyPromise;
}

// ---- error envelope (P3 §16.1) ----
function apiError(res, status, code, layer, message, extra = {}) {
  const body = { code, layer, message, retryable: false, ...extra };
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: body }));
}
const notFound = (res, msg = 'Not found.') => apiError(res, 404, 'not_found', 'server', msg);
const badRequest = (res, msg) => apiError(res, 400, 'invalid', 'app', msg);
const rateLimited = (res, retryAfterS, msg) =>
  apiError(res, 429, 'rate_limited', 'app', msg ?? 'Too many tries in a minute. Wait 30 seconds.', { retryable: true, retry_after_s: retryAfterS });
const chainUnreachable = (res, e) =>
  apiError(res, 503, 'chain_unreachable', 'node', `The testnet is not answering (${e?.message ?? 'no response'}). Showing the last verified data.`, { retryable: true });
// A transient node / transport failure (rate limit, unavailable, timeout)
// is a retryable 503, never a 500 that reads as a bug in the API.
export function isNodeError(e) {
  const msg = String(e?.message ?? e ?? '');
  if ([4, 8, 14].includes(Number(e?.code))) return true; // gRPC DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, UNAVAILABLE
  return /UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|Received HTTP status code (429|502|503|504)|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|node busy/i.test(msg);
}
const internal = (res, e) => {
  console.error('[api] internal error:', e?.message ?? e);
  apiError(res, 500, 'internal', 'server', 'Something went wrong on our side. Nothing was sent unless a transaction link appears above.');
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

// ---- V&A age proof (G8): prover proxy + pay-flow gate. The prover is a
// loopback sidecar on the API host (PROVER_URL, default 127.0.0.1:8788);
// until its secret sidecar file is provisioned, every age-proof route
// fails closed with 503 prover_unavailable and age-gated pays stay 409 —
// except POST /api/age-proof/verify-presentation (F2a), which needs no
// prover: it sends a client-supplied presentation straight to the official
// verifier for verification only (nothing filed, gate untouched).
//
// M2 holder binding: a presentation's credential is identified by its
// credId (did:ccd:<net>:cred:<hex> in credentialSubject.id); the account
// address is resolved on chain below (the SDK accepts a credId as the
// account identifier). A proof is filed only when that holder equals the
// payer; an unresolvable holder files nothing (fail closed).
async function resolveHolderAccount(credIdHex) {
  try {
    const c = await grpc();
    const info = await c.getAccountInfo(CredentialRegistrationId.fromHexString(credIdHex));
    const j = JSON.parse(JSON.stringify(info, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const address = j?.accountAddress;
    return typeof address === 'string' && address ? address : null;
  } catch {
    return null;
  }
}
const ageProof = createAgeProofHandlers({
  readBody, sendJson, apiError, rateLimited, hitWindow, clientIp,
  attemptsPerMinutePerIp: LIMITS.attemptsPerMinutePerIp,
  resolveHolderAccount,
});

async function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ---- known payables (matrix + happy path + this server's fresh ids) ----
const KNOWN_IDS = [1, 2, 3, 4, 5, 10, 11];
// Second seller's known payables (live 2026-11-25): id 1, 0.5 CCD, paid;
// id 2, 10 EUDemo, paid.
const SELLER2_KNOWN_IDS = [1, 2];
async function knownIds2() {
  const counters = await loadCounters();
  return [...new Set([...SELLER2_KNOWN_IDS, ...(counters.freshIds2 ?? [])])].sort((a, b) => a - b);
}
async function knownIds() {
  const counters = await loadCounters();
  return [...new Set([...KNOWN_IDS, ...(counters.freshIds ?? [])])].sort((a, b) => a - b);
}

// Strict resolver for READ handlers (fix-back §4.6): absent ?seller= →
// seller 1 (old links keep working); present and exactly seller 1 or
// seller 2 → that seller; present and anything else → 400 `unknown
// seller` (fail closed, not silent). A mistyped ?seller= on a receipt
// link used to serve seller 1's data with a 200 and no warning. Returns
// null after sending the 400 — callers must `if (!seller) return;`.
function resolveSellerStrict(req, res) {
  let q = null;
  try {
    q = new URL(req.url, 'http://127.0.0.1').searchParams.get('seller');
  } catch { q = null; }
  if (!q) return SELLER;
  if (q === SELLER2_ADDRESS) return SELLER2;
  if (q === SELLER) return SELLER;
  badRequest(res, `unknown seller "${q.slice(0, 32)}": expected seller 1 (${SELLER}) or seller 2 (${SELLER2_ADDRESS}).`);
  return null;
}

// Write-endpoint guard (fix-back §4.4): the write handlers hold no
// seller-2 signing key, so a ?seller= (or a `seller` field in the JSON
// body) naming anything but seller 1 is a loud 400, never a silent
// reinterpretation as seller 1. Returns true when it sent the 400.
function rejectNonSeller1Write(req, res, body = null) {
  let q = null;
  try {
    q = new URL(req.url, 'http://127.0.0.1').searchParams.get('seller');
  } catch { q = null; }
  const named = q ?? (typeof body?.seller === 'string' ? body.seller : null);
  if (!named || named === SELLER) return false;
  badRequest(res, `seller ${named.slice(0, 16)}… is not supported for writes: this server only signs for seller 1 (${SELLER}). Seller-2 writes are a named follow-up, not yet implemented — seller-2 reads (?seller=) already work.`);
  return true;
}

// Write-endpoint resolver for create + pay: no seller named = seller 1 (old
// clients keep working); seller 1 or seller 2 = that seller; anything else is
// a loud 400. The pay flow signs with the DEMO PAYER for both sellers; only
// registering a fresh payable needs the seller's own key. Returns null after
// sending the 400.
function resolveWriteSeller(req, res, body = null) {
  let q = null;
  try {
    q = new URL(req.url, 'http://127.0.0.1').searchParams.get('seller');
  } catch { q = null; }
  const named = q ?? (typeof body?.seller === 'string' ? body.seller : null);
  if (!named || named === SELLER) return SELLER;
  if (named === SELLER2_ADDRESS) return SELLER2;
  badRequest(res, `unknown seller "${String(named).slice(0, 32)}": expected seller 1 (${SELLER}) or seller 2 (${SELLER2_ADDRESS}).`);
  return null;
}

// Fix-back-6 B1 — one scan, fail closed. The old scanPayables silently
// dropped any row whose chain read threw, and both endpoints served the
// partial remainder as 200 OK: /api/stats swung 51/31 → 8/5 and
// /api/invoices 51 → 13 items in the same minute (verified live
// 2026-11-25 09:37 UTC), and the frontend rendered the shrunken numbers.
// Now: each row read retries (3 attempts), the stats + invoices handlers
// share ONE in-flight scan (single-flight, so the two endpoints can never
// be two different partial scans), and an incomplete scan is NEVER served
// as totals — stats falls back to the last complete scan, invoices answers
// 503 node_busy (retryable) so the frontend keeps its last good snapshot.
// Fix-back-7 MF-3: the 20 s stats cache is GONE. It served a warm-cached
// stats body while invoices re-scanned fresh, so a legit state change
// inside the cache window failed all 3 frontend attempts (span ~3 s <
// 20 s TTL) and dashed the dashboard for a poll. Scans are single-flighted
// now, so the cache buys nothing and only hides fresh state.
let scanInFlight = null;
let lastCompleteScan = null;
// Test seam (fix-back-7 S5): handler tests stub the chain reader —
// production always reads the live gRPC client. The seam sits inside the
// per-row retry, so the 503/fallback paths are exercised exactly as the
// handlers run them, with no network and no live chain.
let chainReaderOverride = null;
export function __setChainReaderForTests(fn) {
  chainReaderOverride = fn;
}
// Paid and Voided are terminal on chain (a Paid payable never changes again), so a row
// read in a terminal state is kept for the life of the process. This halves the reads of a
// full scan, which the public node otherwise rate-limits (429 -> node_busy). Not used when
// the test seam is set.
const terminalRows = new Map();
async function readPayableWithRetry(c, id, seller = SELLER, attempts = 3) {
  const ck = `${seller}:${id}`;
  if (!chainReaderOverride && terminalRows.has(ck)) return { view: terminalRows.get(ck), ok: true };
  const out = await readPayableUncached(c, id, seller, attempts);
  if (!chainReaderOverride && out.ok && out.view && (out.view.status === 'Paid' || out.view.status === 'Voided')) terminalRows.set(ck, out.view);
  return out;
}
// The public testnet node answers about 4 reads per second and then 429s. Reads are paced
// to that (one every 250 ms) and a 429 backs off for a full second per attempt.
let lastNodeRead = 0;
async function paceNodeRead() {
  const wait = lastNodeRead + 250 - Date.now();
  lastNodeRead = Math.max(Date.now(), lastNodeRead + 250);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
async function readPayableUncached(c, id, seller = SELLER, attempts = chainReaderOverride ? 3 : 5) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (!chainReaderOverride) await paceNodeRead();
      // A null view is a successful read of an absent payable (never
      // created under this seller), not a skip — only a throw skips.
      const view = chainReaderOverride ? await chainReaderOverride(id, seller) : await getPayableOrNull(c, seller, id);
      return { view, ok: true };
    } catch (e) {
      const base = !chainReaderOverride && /429|RESOURCE_EXHAUSTED/.test(String(e?.message)) ? 1000 : 250;
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, base * (attempt + 1)));
    }
  }
  return { view: null, ok: false };
}
// A complete scan is reused for 8 s (never with the test seam): the dashboard polls both
// endpoints every 30 s from many clients, and a full scan is ~110 sequential node reads that
// the public node answers with 429. 8 s is short enough that a state change shows at once.
const SCAN_TTL_MS = 8000;
async function scanSnapshot(c) {
  if (!chainReaderOverride && lastCompleteScan && Date.now() - lastCompleteScan.at < SCAN_TTL_MS) {
    return { rows: lastCompleteScan.rows, skipped: [], complete: true };
  }
  if (scanInFlight) return scanInFlight;
  scanInFlight = (async () => {
    const rows = [];
    const skipped = [];
    for (const id of await knownIds()) {
      const { view, ok } = await readPayableWithRetry(c, id);
      if (ok) {
        if (view) rows.push(view);
      } else {
        skipped.push(id);
      }
    }
    // Frontier discovery: payables registered beyond the server's counter
    // (a counter that regressed or never saw them) are still on chain. Probe
    // upward from the highest known fresh id until three consecutive ids are
    // absent, count what is found and fold it into the counters, so
    // payables_total is derivable from the registry and not from a stored
    // list that can fall behind.
    {
      const ids = await knownIds();
      const top = Math.max(FRESH_ID_START - 1, ...ids.filter((i) => i >= FRESH_ID_START));
      const found = [];
      let misses = 0;
      for (let id = top + 1; misses < 3 && id <= top + 200; id += 1) {
        const { view, ok } = await readPayableWithRetry(c, id);
        if (!ok) { skipped.push(id); break; }
        if (view) { rows.push(view); found.push(id); misses = 0; } else misses += 1;
      }
      if (found.length) await foldDiscoveredIds(found);
    }
    // Second seller (main 86e2596 wiring): seller-2 rows are part of the
    // served list, so they get the same retry + fail-closed treatment --
    // a failed seller-2 read fails the scan, it never silently drops
    // seller-2 rows the way main's scanPayables did.
    for (const id of await knownIds2()) {
      const { view, ok } = await readPayableWithRetry(c, id, SELLER2);
      if (ok) {
        if (view) rows.push(view);
      } else {
        skipped.push(id);
      }
    }
    // Seller 2 frontier: same discovery as seller 1, from its own id range.
    {
      const ids2 = await knownIds2();
      const top2 = Math.max(SELLER2_FRESH_ID_START - 1, ...ids2.filter((i) => i >= SELLER2_FRESH_ID_START));
      const found2 = [];
      let misses2 = 0;
      for (let id = top2 + 1; misses2 < 3 && id <= top2 + 200; id += 1) {
        const { view, ok } = await readPayableWithRetry(c, id, SELLER2);
        if (!ok) { skipped.push(id); break; }
        if (view) { rows.push(view); found2.push(id); misses2 = 0; } else misses2 += 1;
      }
      if (found2.length) await foldDiscoveredIds(found2, 2);
    }
    const scan = { rows, skipped, complete: scanIsComplete(skipped) };
    if (scan.complete) lastCompleteScan = { at: Date.now(), rows };
    return scan;
  })();
  try {
    return await scanInFlight;
  } finally {
    scanInFlight = null;
  }
}

function amountDisplay(view) {
  return view.asset === 'CCD'
    ? `${(Number(view.amount) / 1e6).toFixed(6)} CCD`
    : `${(Number(view.amount) / 1e6).toFixed(2)} EUDemo`;
}

export function labelFor(view) {
  // Seller-key rule: ids 1-5 are seller 1's contract-matrix payables.
  // Seller 2's payable 1 / 2 are lab invoices, not matrix payables.
  const base = view.seller === SELLER2 || view.id >= 1000 || view.id === 10 || view.id === 11
    ? 'Lab invoice (testnet, not a real invoice)'
    : 'Contract-matrix test payable (testnet)';
  // The facts type carries its own voided kind (payableFacts, fix-back-8
  // MF-1); the label still says so in words, and the verify endpoint (the
  // enforcement point) reports the voided status and blocks payment.
  return view.status === 'Voided' ? `Voided on chain — ${base}` : base;
}

// ---- config (reservation_secs + vendor list read live, cached 5 min) ----
let configCache = { at: 0, reservationSecs: RESERVATION_SECS, vendorList: null };
async function liveConfig(c) {
  const now = Date.now();
  if (now - configCache.at < 300_000 && configCache.vendorList) return configCache;
  try {
    const cfg = await getChainConfig(c);
    configCache.reservationSecs = cfg.reservation_secs;
  } catch { /* keep the configured default */ }
  try {
    // Both approvals are checked live (fix-back §4.7): a seller is
    // listed only when its on-chain vendor row exists (getVendor returns
    // null when there is no row). The old code fetched seller 1's
    // approval into an unused variable and listed both sellers
    // unconditionally in both branches — so
    // `build.vendor_list_enforced_by_co_signer: true` was claimed but
    // not enforced in code. It is now true in code.
    const approval1 = await getVendor(c, PAYER_ADDRESS, OWNER_ADDRESS);
    const approval2 = await getVendor(c, PAYER_ADDRESS, SELLER2_ADDRESS);
    const list = [];
    if (approval1) list.push({ seller: OWNER_ADDRESS, label: 'Lab seller account (demo seller)' });
    if (approval2) list.push({ seller: SELLER2_ADDRESS, label: 'Second seller account (PayOnce Seller 2)' });
    configCache.vendorList = list;
  } catch {
    // gRPC error: keep the previous list when there is one; otherwise
    // fail closed with an empty list (never claim a vendor the chain
    // did not confirm). The old catch branch listed seller 1
    // unconditionally — that behaviour is gone, see CHANGES.md.
    if (!configCache.vendorList) configCache.vendorList = [];
  }
  configCache.at = now;
  return configCache;
}

// ---- route handlers ----
async function handleConfig(req, res) {
  const c = await grpc();
  const live = await liveConfig(c);
  sendJson(res, 200, {
    network: NETWORK,
    registry: { index: REGISTRY.index, subindex: REGISTRY.subindex, module_ref: REGISTRY.moduleRef },
    cis8004_test_instance: {
      index: CIS8004_OFFICIAL.index,
      subindex: CIS8004_OFFICIAL.subindex,
      official_module_ref: CIS8004_OFFICIAL.moduleRef,
      is_official_registry: true,
    },
    reservation_secs: live.reservationSecs,
    co_signer_margin_secs: CO_SIGNER_MARGIN_SECS,
    assets: {
      ccd: { decimals: 6, label: 'CCD (testnet)' },
      eudemo: { decimals: 6, label: 'EUDemo (testnet demo token, not a euro stablecoin)' },
    },
    payer_label: 'Demo payer account (lab)',
    sponsor_label: 'Lab seller account (pays agent-wallet gas)',
    explorer: { tx: EXPLORER_TX, instance: EXPLORER_INSTANCE },
    vendor_list: live.vendorList,
    sellers: [
      {
        seller: OWNER_ADDRESS,
        label: 'Seller 1 — PayOnce Seller',
        agent_token: OWNER_TOKEN,
        badge: 'JyP9XawpXHMjTN5ocrA5a',
        badge_url: 'https://agent-registry-mcp.concordium.com/v1/badge-check/JyP9XawpXHMjTN5ocrA5a',
        agent_card_url: 'https://payonce-tau.vercel.app/.well-known/agent-card.json',
      },
      {
        seller: SELLER2_ADDRESS,
        label: 'Seller 2 — PayOnce Seller 2',
        agent_token: SELLER2_TOKEN,
        badge: SELLER2_BADGE,
        badge_url: `https://agent-registry-mcp.concordium.com/v1/badge-check/${SELLER2_BADGE}`,
        agent_card_url: SELLER2_AGENT_CARD_URL,
      },
    ],
    build: {
      // Which sellers' invoices this server can register and pay through the
      // API (the demo payer signs the payments for both).
      seller_writes: ['seller_1', 'seller_2'],
      vendor_list_enforced_by_co_signer: true,
      named_payer_on_invoice: true,
      confirm_by: 'payer (the reserving payer)',
      header_expiry_bound: true,
      co_signer_runs_as: 'decision gate inside this API server (no separate service)',
    },
    limits: {
      new_invoices_per_hour: LIMITS.newInvoicesPerHour,
      attempts_per_minute_per_ip: LIMITS.attemptsPerMinutePerIp,
    },
    verifier: { file: 'verify-payable-v2.mjs', version_date: '2026-11-24' },
    // Workshop fix-back (W-01/W-11, W-26, W-23, W-07, W-31): consent anchor
    // (ask-me threshold), the hosted registry MCP (testnet only), the buyer
    // agent, the fee peg, and the balance watch.
    consent: {
      ask_me_threshold: '1 CCD or 1.00 EUDemo (1,000,000 base units)',
      ask_me_threshold_base: ASK_ME_THRESHOLD_BASE.toString(),
      validity_seconds: CONSENT_VALIDITY_SECS,
      domain: CONSENT_DOMAIN,
      lab_anchors: { vra: LAB_CONSENT_ANCHORS.vra, vaa: LAB_CONSENT_ANCHORS.vaa, consent_sha256: LAB_CONSENT_ANCHORS.consentSha256 },
      va_anchors: { vra: LAB_VA_ANCHORS.vra, vaa: LAB_VA_ANCHORS.vaa },
    },
    mcp: { url: MCP_URL, network: 'testnet', tools: 41, note: 'network=testnet is passed on every call; the server default is mainnet' },
    buyer_agent: (await loadBuyerAgent()) ?? { account: BUYER_ACCOUNT, token_id: null, status: 'not_registered' },
    fee_peg: { per_transaction_eur: 0.01, basis: 'Concordium fee peg (W1 §1.2): €0.01 per transaction; see the fee table on the judge page' },
    balance_watch: { ok_threshold_micro_ccd: BALANCE_OK_MICROCCD.toString(), accounts: ['payer (seller B)', 'sponsor (owner)', 'EUDemo wallet'] },
    as_of: new Date().toISOString(),
  });
}

async function handleHealth(req, res) {
  const ip = clientIp(req);
  const c = await grpc();
  let chainOk = false;
  try {
    await c.getConsensusStatus();
    chainOk = true;
  } catch { chainOk = false; }
  const { chain } = await backend();
  let payer = { status: 'empty' };
  let sponsor = { status: 'empty' };
  let walletEudemo = { status: 'low' };
  if (chainOk) {
    try {
      const info = await getAccount(c, PAYER_ADDRESS);
      const available = BigInt(microCcdOf(info.accountAvailableBalance ?? info.accountAmount));
      payer = { status: available >= 50_000_000n ? 'ok' : available > 0n ? 'low' : 'empty' };
      const eudemo = BigInt(chain.tokenBalance(info, 'EUDemo'));
      walletEudemo = { status: eudemo > 0n ? 'ok' : 'low' };
    } catch { /* balances stay at the safe defaults */ }
    try {
      const info = await getAccount(c, OWNER_ADDRESS);
      const available = BigInt(microCcdOf(info.accountAvailableBalance ?? info.accountAmount));
      sponsor = { status: available >= 50_000_000n ? 'ok' : available > 0n ? 'low' : 'empty' };
    } catch { /* keep empty */ }
  }
  sendJson(res, 200, {
    chain: { reachable: chainOk, checked_at: new Date().toISOString() },
    node_busy: !chainOk,
    payer,
    sponsor,
    wallet_eudemo: walletEudemo,
    co_signer: { status: 'ok' },
    budget: {
      new_invoices_left_this_hour: await leftInWindow(`inv:${ip}`, 3_600_000, LIMITS.newInvoicesPerHour),
      attack_sends_left_this_hour: await leftInWindow(`atk:${ip}`, 3_600_000, LIMITS.attackSendsPerHour),
    },
  });
}

// Refusal provenance: distinct rejected-transaction hashes, split by where
// the server learned of them. Used by the stats body AND /api/stats/refusals
// so the count is always the length of the list.
async function refusalLedger() {
  const counters = await loadCounters();
  const recorded = recordedRefusals();
  const items = [];
  const seen = new Set();
  for (const [txHash, r] of recorded) {
    seen.add(txHash);
    items.push({ tx_hash: txHash, reject_code: r.code ?? null, origin: 'recorded_evidence', source: r.source ?? null });
  }
  for (const r of counters.liveRefusals ?? []) {
    if (seen.has(r.txHash)) continue;
    seen.add(r.txHash);
    items.push({ tx_hash: r.txHash, reject_code: r.code ?? null, origin: 'live_this_server', source: null, at: r.at ?? null });
  }
  return items;
}

function sellerCounts(rows) {
  const out = {};
  for (const [name, addr] of [['seller_1', SELLER], ['seller_2', SELLER2]]) {
    const mine = listableRows(rows).filter((r) => r.seller === addr);
    out[name] = { seller: addr, payables_total: mine.length, paid_total: mine.filter((r) => r.status === 'Paid').length };
  }
  return out;
}

async function handleStats(req, res) {
  const c = await grpc();
  const scan = await scanSnapshot(c);
  const counters = await loadCounters();
  // Reconciled at source: the total counts the same listable rows the
  // /api/invoices list shows (never the raw scanned rows).
  const refusals = await refusalLedger();
  const common = {
    refusedCount: refusals.length,
    lastVerifierRunAt: counters.lastVerifierRunAt,
    generatedAt: new Date().toISOString(),
    recordedRefusals: refusals.filter((r) => r.origin === 'recorded_evidence').length,
    liveRefusals: refusals.filter((r) => r.origin === 'live_this_server').length,
  };
  if (!scan.complete) {
    // Fail closed (fix-back-6 B1): a partial scan is never served as
    // totals. The last complete scan's stats stay the answer (labelled
    // stale, with the time it was read); with no complete scan yet, 503
    // node_busy (retryable) — the frontend keeps its last good snapshot
    // instead of rendering shrunken numbers.
    if (lastCompleteScan) {
      const body = statsBody({
        rows: lastCompleteScan.rows,
        scannedAt: new Date(lastCompleteScan.at).toISOString(),
        stale: true,
        sellers: sellerCounts(lastCompleteScan.rows),
        ...common,
      });
      return sendJson(res, 200, body);
    }
    return apiError(res, 503, 'node_busy', 'node', 'The testnet node did not answer for every payable just now. Nothing was counted from a partial scan — retry.', { retryable: true });
  }
  const body = statsBody({ rows: scan.rows, scannedAt: new Date(lastCompleteScan?.at ?? Date.now()).toISOString(), stale: false, sellers: sellerCounts(scan.rows), ...common });
  sendJson(res, 200, body);
}

// GET /api/stats/refusals — the list behind refused_on_chain_since_deploy.
// Every entry is a transaction the chain rejected; the count in /api/stats
// is exactly this list's length.
async function handleStatsRefusals(req, res) {
  const items = (await refusalLedger()).map((r) => ({ ...r, explorer_url: txUrl(r.tx_hash) }));
  sendJson(res, 200, {
    generated_at: new Date().toISOString(),
    count: items.length,
    basis: 'distinct transaction hashes the chain rejected: recorded evidence files plus refusals this server logged live. Re-check any hash with GET /api/tx/<hash>/status.',
    items,
  });
}

async function handleInvoices(req, res) {
  const c = await grpc();
  const scan = await scanSnapshot(c);
  // Fail closed (fix-back-6 B1): a partial list is never served as 200 --
  // the frontend keeps its last good snapshot on a retryable 503.
  if (!scan.complete) {
    return apiError(res, 503, 'node_busy', 'node', 'The testnet node did not answer for every payable just now. No partial list is served -- retry.', { retryable: true });
  }
  const items = listableRows(scan.rows)
    .sort((a, b) => (a.seller === b.seller ? a.id - b.id : a.seller < b.seller ? -1 : 1))
    .map((r) => ({
      payable_id: r.id,
      seller: r.seller,
      asset: r.asset === 'CCD' ? 'ccd' : 'eudemo',
      amount_display: amountDisplay(r),
      due: r.due,
      status: r.status,
      label: labelFor(r),
    }));
  sendJson(res, 200, { items });
}

async function payableFacts(c, view, chainTimeMs) {
  const { txs, source } = await paymentTxsFor(view.id, view);
  let paymentTx = '';
  if (view.status === 'Paid') {
    if (view.asset === 'EUDemo' && view.record?.txHash) paymentTx = view.record.txHash;
    else paymentTx = txs.find(([l]) => l === 'Transfer' || l === 'Payment')?.[1] ?? '';
  }
  return {
    payable_id: view.id,
    asset: { kind: view.asset === 'CCD' ? 'ccd' : 'eudemo', token: view.asset },
    amount: view.amount,
    amount_display: amountDisplay(view),
    payee: view.payee,
    seller: view.seller,
    due: view.due,
    is_past_due: chainTimeMs > Number(view.dueMs),
    status: view.status === 'Unpaid'
      ? { kind: 'unpaid' }
      : view.status === 'Reserved'
        ? { kind: 'reserved', payer: view.record.payer, expires: view.record.expires }
        : view.status === 'Paid'
          ? {
              kind: 'paid',
              payer: view.record.payer,
              paid_at: view.record.paidAt,
              payment_tx: paymentTx,
              payment_tx_source: view.asset === 'EUDemo' && view.record?.txHash ? 'chain' : source,
            }
          // Fix-back-8 MF-1: Voided is its own facts kind now (it used to
          // map to {kind:'unpaid'} with the truth only in the label, so a
          // frontend could not tell a voided row from a still-payable one
          // without sniffing the label). The verify/pay endpoints still
          // enforce on view.status directly — this changes only the facts
          // surface, and the label still says "Voided on chain — …".
          : view.status === 'Voided'
            ? { kind: 'voided' }
            : { kind: 'unpaid' },
    agent: { registry: { index: CIS8004_OFFICIAL.index, subindex: CIS8004_OFFICIAL.subindex }, token: view.agentToken },
    doc_sha256: view.docHash,
    label: labelFor(view),
  };
}

async function handleGetPayable(req, res, id) {
  const seller = resolveSellerStrict(req, res);
  if (!seller) return;
  const c = await grpc();
  // Fix-back-9 MF-4: the read goes through the S5 test seam
  // (readPayableWithRetry) like the stats/invoices scans, so the
  // handler is testable offline with a stubbed chain reader. A read
  // that fails all 3 retries is a 503, never a partial answer; the
  // live-chain path is unchanged when no override is set.
  const { view, ok } = await readPayableWithRetry(c, id, seller);
  if (!ok) return chainUnreachable(res, new Error(`the testnet node did not answer for payable ${id}`));
  if (!view) return notFound(res, `No payable ${id} is on the test registry <${REGISTRY.index},${REGISTRY.subindex}>.`);
  const now = await chainNow(c);
  sendJson(res, 200, await payableFacts(c, view, now.slotMs));
}

async function handleDocument(req, res, id) {
  const seller = resolveSellerStrict(req, res);
  if (!seller) return;
  const c = await grpc();
  const { view, ok } = await readPayableWithRetry(c, id, seller);
  if (!ok) return chainUnreachable(res, new Error(`the testnet node did not answer for payable ${id}`));
  if (!view) return notFound(res, `No payable ${id} is on the test registry <${REGISTRY.index},${REGISTRY.subindex}>.`);
  const doc = await docForPayableForSeller(seller, id);
  if (!doc) return notFound(res, `No lab document is stored for payable ${id}. Only lab documents are served here.`);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(doc);
}

/** Reservation + confirm evidence for an EUDemo after_pay run, from the
 * stored payment legs (receipt store / recorded evidence — the same
 * legs paymentTxsFor returns). G7 fix-back-3 MF-3: verifyPltV2 is now
 * fail-closed on missing reserve/confirm, so the handler must supply
 * the evidence it already holds — otherwise /api/verify could never
 * certify any PLT payment. A leg that cannot be fetched (or has no
 * reserve_plt event) comes back null and the verifier FAILS that row
 * instead of passing it silently; a fetch failure never throws here. */
async function pltEvidenceFor(c, txs) {
  const leg = (label) => txs.find(([l]) => l === label)?.[1] ?? null;
  let reserve = null;
  let confirm = null;
  const reserveHash = leg('Reservation');
  if (reserveHash) {
    try {
      const { v2ev } = await backend();
      const rs = await getTx(c, reserveHash);
      const rbt = await getBlockTime(c, rs.blockHash);
      const upd = updatedEvent(rs, 'reserve_plt');
      reserve = { blockTime: rbt, logged: upd ? v2ev.decodeLoggedEventsV2(upd) : [] };
    } catch {
      reserve = null;
    }
  }
  const confirmHash = leg('Confirm');
  if (confirmHash) {
    try {
      const { v2ev } = await backend();
      const cs = await getTx(c, confirmHash);
      // G7 fix-back-4 ADV-2: the confirm carries its decoded PltConfirmed
      // event (same shape as the reserve leg above) — pltConfirmRow now
      // requires the event, not just the block time.
      // G7 fix-back-6 MF-1: gen 'v2' is a CALLER signal — this handler
      // reads the view from the v2 registry, so the confirm it builds is
      // v2 by construction; the verifier must not re-derive the
      // generation from the event's own (strippable) schemaVersion.
      // G7 fix-back-7 MF-1: the verifier no longer reads ANY generation
      // signal (ctx or confirm) — seller + finite expiry are
      // unconditional. The gen field below is kept for shape stability
      // only; it decides nothing.
      const cupd = updatedEvent(cs, 'confirm_plt');
      confirm = { blockTime: await getBlockTime(c, cs.blockHash), logged: cupd ? v2ev.decodeLoggedEventsV2(cupd) : [], gen: 'v2' };
    } catch {
      confirm = null;
    }
  }
  return { reserve, confirm };
}

async function handleVerify(req, res, id) {
  const body = await readBody(req).catch(() => ({}));
  const mode = body.mode === 'after_pay' ? 'after_pay' : 'before_pay';
  const docSha256 = typeof body.doc_sha256 === 'string' ? body.doc_sha256 : null;
  const started = Date.now();
  const seller = resolveSellerStrict(req, res);
  if (!seller) return;
  const c = await grpc();
  const view = await getPayableOrNull(c, seller, id);
  if (!view) return notFound(res, `No payable ${id} is on the test registry <${REGISTRY.index},${REGISTRY.subindex}>.`);
  const now = await chainNow(c);
  const docBytes = docSha256 ? null : await docForPayableForSeller(seller, id);
  const { chain } = await backend();
  const payerInfo = await getAccount(c, PAYER_ADDRESS);
  const payerBalances = {
    ccdAvailableMicro: microCcdOf(payerInfo.accountAvailableBalance ?? payerInfo.accountAmount),
    eudemoBase: chain.tokenBalance(payerInfo, 'EUDemo'),
  };

  if (mode === 'before_pay') {
    const result = await verifyBeforePay(c, { view, docBytes, docSha256, chainTimeMs: now.slotMs, payerBalances });
    await updateCounters((counters) => {
      counters.verifierRuns += 1;
      if (result.allPass) counters.verifierPassed += 1; else counters.verifierFailed += 1;
      counters.lastVerifierRunAt = new Date().toISOString();
    });
    // Consent anchor (W-01, reported beside the 9 P3 checks — the check
    // counts stay exactly 9/10/12, so the existing suites keep passing).
    // Seller-aware (fix-back §4.3): the verify caller's seller, not the
    // bare payable id, selects the consent record.
    const consentRecord = await consentForSeller(seller, id);
    const consent = consentRecord
      ? {
          ...publicConsent(consentRecord),
          anchor_verified: consentRecord.vraTx ? (await verifyConsentVra({ grpcClient: c, record: consentRecord })).ok : false,
        }
      : {
          payable_id: id,
          status: isAboveAskMeThreshold(view) ? 'required' : 'not_required',
          above_threshold: isAboveAskMeThreshold(view),
          note: isAboveAskMeThreshold(view)
            ? 'At or above the ask-me threshold (1 CCD / 1.00 EUDemo): the owner must approve this payable first (POST /api/consent/request).'
            : 'Below the ask-me threshold (1 CCD / 1.00 EUDemo): owner consent is not required for this payable.',
        };
    return sendJson(res, 200, {
      payable_id: id, mode, verdict: result.verdict,
      passed: result.passed, total: result.total,
      blocked_reason: result.blockedReason, checks: result.checks,
      consent,
      checked_at: new Date().toISOString(), read_ms: Date.now() - started,
    });
  }

  // after_pay: the payment tx comes from the store / evidence index.
  const { txs } = await paymentTxsFor(id, view);
  const balance = await getRegistryBalance(c);
  if (view.status !== 'Paid') {
    return sendJson(res, 200, {
      payable_id: id, mode, verdict: 'blocked',
      passed: 0, total: view.asset === 'CCD' ? 10 : 14, // MF-3: EUDemo after_pay is now a 14-check run
      blocked_reason: 'status',
      checks: [{
        id: 'status_paid', label: 'Registry status is Paid', status: 'fail',
        detail: `status=${view.status} — the payable has not been paid yet.`, layer: 'chain',
      }],
      checked_at: new Date().toISOString(), read_ms: Date.now() - started,
    });
  }
  const payHash = view.asset === 'CCD'
    ? txs.find(([l]) => l === 'Payment')?.[1]
    // Defense in depth (fix-back §4.1): accept a 'Payment'-labelled leg
    // as the transfer hash when no 'Transfer' leg exists.
    : txs.find(([l]) => l === 'Transfer')?.[1] ?? txs.find(([l]) => l === 'Payment')?.[1];
  if (!payHash) {
    return sendJson(res, 200, {
      payable_id: id, mode, verdict: 'blocked',
      passed: 0, total: view.asset === 'CCD' ? 10 : 14, // MF-3: EUDemo after_pay is now a 14-check run
      blocked_reason: 'no_payment_tx',
      checks: [{
        id: 'tx_finalized', label: 'Payment transaction is finalized', status: 'not_run',
        detail: 'No payment transaction is recorded for this payable (not in the server store, not in the recorded evidence). The chain status is Paid, but the payment transaction cannot be re-verified without its hash.',
        layer: 'server',
      }],
      checked_at: new Date().toISOString(), read_ms: Date.now() - started,
    });
  }
  const summary = await getTx(c, payHash);
  const blockTime = await getBlockTime(c, summary.blockHash);
  // MF-3: the EUDemo run supplies the stored reserve/confirm evidence
  // (pltEvidenceFor) — without it the fail-closed rows would fail every
  // PLT verification, including real paid payables.
  const pltEvidence = view.asset === 'EUDemo' ? await pltEvidenceFor(c, txs) : { reserve: null, confirm: null };
  const result = view.asset === 'CCD'
    ? await verifyCcdV2(c, { payableId: id, txHash: payHash, summary, blockTime, view, balance, docBytes, docSha256 })
    // G7 fix-back-7 MF-1: the registryIndex/gen pair below is passed
    // for interface stability only — the verifier no longer reads any
    // generation signal (fix-back-6's caller threading let a '13149' /
    // 'v1' signal lift the seller + expiry requirements). This run is
    // v2 because the view comes from the v2 registry <13150,0> and the
    // verifier is v2-only unconditionally.
    : await verifyPltV2(c, { payableId: id, txHash: payHash, summary, blockTime, view, balance, docBytes, docSha256, reserve: pltEvidence.reserve, confirm: pltEvidence.confirm, registryIndex: String(REGISTRY.index), gen: 'v2' });
  await updateCounters((counters) => {
    counters.verifierRuns += 1;
    if (result.allPass) counters.verifierPassed += 1; else counters.verifierFailed += 1;
    counters.lastVerifierRunAt = new Date().toISOString();
  });
  const failed = result.checks.find((ch) => ch.status === 'fail');
  sendJson(res, 200, {
    payable_id: id, mode, verdict: result.allPass ? 'paid' : 'blocked',
    passed: result.passed, total: result.total,
    blocked_reason: result.allPass ? null : failed?.id ?? 'failed',
    checks: result.checks,
    checked_at: new Date().toISOString(), read_ms: Date.now() - started,
  });
}

async function handleCreatePayable(req, res) {
  const ip = clientIp(req);
  const body = await readBody(req).catch(() => ({}));
  const seller = resolveWriteSeller(req, res, body);
  if (!seller) return;
  const isS2 = seller === SELLER2;
  const asset = body.asset === 'eudemo' ? 'eudemo' : body.asset === 'ccd' ? 'ccd' : null;
  if (!asset) return badRequest(res, 'asset must be "ccd" or "eudemo".');
  const attempt = await hitWindow(`att:${ip}`, 60_000, LIMITS.attemptsPerMinutePerIp);
  if (!attempt.allowed) return rateLimited(res, Math.ceil(attempt.resetMs / 1000));
  const budget = await hitWindow(`inv:${ip}`, 3_600_000, LIMITS.newInvoicesPerHour);
  if (!budget.allowed) {
    return apiError(res, 429, 'budget_exhausted', 'app', 'The demo’s budget for new invoices is used up for this hour. Use a lab invoice.', { retryable: true, retry_after_s: Math.ceil(budget.resetMs / 1000) });
  }
  const c = await grpc();
  const { v2enc } = await backend();
  const amount = asset === 'ccd' ? FRESH_CCD_MICRO : FRESH_EUDEMO_BASE;
  // Seller 1 pays the lab payees; seller 2's own payables pay seller 2 itself.
  const payee = isS2 ? SELLER2_ADDRESS : asset === 'ccd' ? PAYEE_CCD : PAYEE_EUDEMO;
  const sig = await signers();
  const sellerSigner = isS2 ? sig.seller2 : sig.owner;
  if (!sellerSigner) return apiError(res, 503, 'seller_key_unavailable', 'server', 'This server holds no signing key for that seller, so it cannot register an invoice for it. Nothing was sent.', { retryable: false });
  let reg;
  try {
    // The id is allocated atomically and a chain Duplicate (-2) moves on to
    // the next id (see fresh-id.mjs). The document is stored only AFTER the
    // registration succeeded, so a duplicate never overwrites the document
    // of the payable that already owns that id.
    reg = await registerWithFreshId(async (id) => {
      const dueMs = Date.now() + FRESH_DUE_HOURS * 3_600_000;
      const docText = generateLabDocument({ id, asset: asset === 'ccd' ? 'CCD' : 'EUDemo', amount: amount.toString(), payee, seller, due: dueMs });
      const docHash = createHash('sha256').update(Buffer.from(docText, 'utf8')).digest('hex');
      const sent = await sendUpdate(c, {
        from: sellerSigner, receiveName: 'register_payable',
        parameterHex: v2enc.encodeV2RegisterPayable({
          id, payee, amount: amount.toString(), asset: asset === 'ccd' ? 'CCD' : 'EUDemo',
          dueMs, docHashHex: docHash, token: isS2 ? SELLER2_TOKEN : OWNER_TOKEN, expected: PAYER_ADDRESS, legal: null,
        }),
        maxEnergy: 6000n,
      });
      const status = await waitFinalized(c, sent.txHash);
      const rr = rejectOf(status);
      return { txHash: sent.txHash, status, docText, dueMs, rejected: rr ? rejectInfo(rr.rejectReason) : null };
    }, { which: isS2 ? 2 : 1 });
  } catch (e) {
    return chainUnreachable(res, e);
  }
  if (!reg.ok) {
    const info = reg.rejected;
    await updateCounters((counters2) => {
      counters2.liveRefusals.push({ txHash: reg.txHash, code: info.code, at: new Date().toISOString() });
    });
    return apiError(res, 409, 'chain_refused', 'chain', `The chain refused the registration (${info.code} ${info.name}).`, { reject: info, fee_testnet_ccd: feeOf(reg.status), tx_hash: reg.txHash, explorer_url: txUrl(reg.txHash) });
  }
  await storeDocument(reg.id, reg.docText);
  sendJson(res, 201, {
    payable_id: reg.id,
    seller,
    tx_hash: reg.txHash,
    explorer_url: txUrl(reg.txHash),
    fee_testnet_ccd: feeOf(reg.status) ?? '0',
    due: new Date(reg.dueMs).toISOString(),
  });
}

async function handlePay(req, res, id) {
  const ip = clientIp(req);
  const body = await readBody(req).catch(() => ({}));
  const seller = resolveWriteSeller(req, res, body);
  if (!seller) return;
  const rail = body.rail === 'eudemo' ? 'eudemo' : body.rail === 'ccd' ? 'ccd' : null;
  if (!rail) return badRequest(res, 'rail must be "ccd" or "eudemo".');
  const docSha256 = typeof body.doc_sha256 === 'string' ? body.doc_sha256 : null;
  const attempt = await hitWindow(`att:${ip}`, 60_000, LIMITS.attemptsPerMinutePerIp);
  if (!attempt.allowed) return rateLimited(res, Math.ceil(attempt.resetMs / 1000));
  const c = await grpc();
  const view = await getPayableOrNull(c, seller, id);
  if (!view) return notFound(res, `No payable ${id} is on the test registry <${REGISTRY.index},${REGISTRY.subindex}>.`);
  const expectedAsset = rail === 'ccd' ? 'CCD' : 'EUDemo';
  if (view.asset !== expectedAsset) {
    return apiError(res, 409, 'wrong_asset', 'app', `Payable ${id} is a ${view.asset} payable, not ${expectedAsset}. Use the ${view.asset === 'CCD' ? 'ccd' : 'eudemo'} rail.`);
  }
  if (docSha256 && docSha256.toLowerCase() !== view.docHash.toLowerCase()) {
    return apiError(res, 409, 'doc_mismatch', 'app', `The supplied document fingerprint does not match the on-chain hash for payable ${id}. The document on file is not the one that was registered.`);
  }
  if (view.status === 'Paid') {
    return apiError(res, 409, 'already_paid', 'chain', `Payable ${id} is already Paid by ${view.record?.payer?.slice(0, 8)}… at ${view.record?.paidAt ?? '—'}.`);
  }
  if (view.status === 'Reserved') {
    return apiError(res, 409, 'reserved_by_other', 'chain', `Payable ${id} is Reserved by ${view.record?.payer?.slice(0, 8)}… until ${view.record?.expires ?? '—'}. Wait for the reservation to expire.`);
  }
  if (view.status === 'Voided') {
    return apiError(res, 409, 'wrong_status', 'chain', `Payable ${id} is Voided and cannot be paid.`);
  }
  // Consent gate (W-01): an above-threshold payable needs an approved,
  // unexpired, unused owner consent before the pay job is created. Below
  // the threshold the gate passes (consent is optional there).
  const consentRecord = await consentForSeller(seller, id);
  const consentGate = consentGateCheck(view, consentRecord);
  if (consentGate) {
    return apiError(res, consentGate.status, consentGate.code, consentGate.layer, consentGate.message, { consent_url: consentGate.consent_url, payable_id: consentGate.payable_id });
  }
  // G8 age gate: payables >= 1 CCD or >= 1.00 EUDemo need a fresh
  // (<=10 min) verified 18+ presentation for the payer on file for this
  // payable — filed only via POST /api/age-proof/verify, never trusted
  // from a client claim. Below the threshold age proof is optional.
  const gate = ageGateCheck(view, PAYER_ADDRESS);
  if (gate) {
    return apiError(res, gate.status, gate.code, gate.layer, gate.message, {
      verify_url: gate.verify_url, payable_id: gate.payable_id,
    });
  }
  const { job, created } = await createOrReturnJob(id, rail, seller);
  if (created) void runJob(job);
  sendJson(res, 200, {
    job_id: job.job_id, payable_id: job.payable_id, seller: job.seller ?? seller, rail: job.rail,
    steps: job.steps.map((s) => s.step),
  });
}

async function handleGetJob(req, res, jobId) {
  const jobs = await loadJobs();
  const job = jobs[jobId];
  if (!job) return notFound(res, `No job ${jobId}.`);
  sendJson(res, 200, job);
}

async function handleJobEvents(req, res, jobId) {
  const jobs = await loadJobs();
  const job = jobs[jobId];
  if (!job) return notFound(res, `No job ${jobId}.`);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(job)}\n\n`);
  if (job.state !== 'running') {
    res.write(`data: ${JSON.stringify({ type: 'done', outcome: job.outcome, receipt_url: `/api/receipts/${job.payable_id}` })}\n\n`);
    return res.end();
  }
  subscribeJob(jobId, res);
  const beat = setInterval(async () => {
    const current = (await loadJobs())[jobId];
    if (!current || current.state !== 'running') {
      clearInterval(beat);
      try {
        if (current) res.write(`data: ${JSON.stringify({ type: 'done', outcome: current.outcome, receipt_url: `/api/receipts/${current.payable_id}` })}\n\n`);
      } catch { /* client gone */ }
      try { res.end(); } catch { /* already closed */ }
      return;
    }
    try { res.write(': ping\n\n'); } catch { clearInterval(beat); }
  }, 5000);
  req.on('close', () => { clearInterval(beat); unsubscribeJob(jobId, res); });
}

async function handleTxStatus(req, res, hash) {
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) return badRequest(res, 'tx hash must be 64 hex characters.');
  const c = await grpc();
  let status;
  try {
    status = await getTx(c, hash.toLowerCase());
  } catch {
    return notFound(res, `No transaction ${hash.slice(0, 8)}… is known to the testnet yet.`);
  }
  const rr = rejectOf(status);
  sendJson(res, 200, {
    tx_hash: hash.toLowerCase(),
    status: status.status,
    reject: rr ? rejectInfo(rr.rejectReason) : null,
    fee_testnet_ccd: feeOf(status) ?? '0',
    explorer_url: txUrl(hash.toLowerCase()),
  });
}

async function handleDryRun(req, res) {
  const body = await readBody(req).catch(() => ({}));
  if (rejectNonSeller1Write(req, res, body)) return;
  const payableId = Number(body.payable_id);
  const to = typeof body.to === 'string' ? body.to : null;
  const amount = body.amount != null ? String(body.amount) : null;
  const memoInput = typeof body.memo === 'string' ? body.memo : null;
  if (!Number.isInteger(payableId) || payableId < 1 || !to || !amount || !memoInput) {
    return badRequest(res, 'dry-run needs { payable_id, to, amount, memo }.');
  }
  const c = await grpc();
  const view = await getPayableOrNull(c, SELLER, payableId);
  if (!view) return notFound(res, `No payable ${payableId} is on the test registry <${REGISTRY.index},${REGISTRY.subindex}>.`);
  const { chain, decideMod } = await backend();
  const decide = decideMod.decide;
  // The memo arrives as text (`payable:<seller>:<id>`) or as CBOR hex.
  let memoHex;
  if (/^[0-9a-fA-F]+$/.test(memoInput) && memoInput.length % 2 === 0) {
    try {
      const decoded = chain.decodeCborMemo(memoInput);
      memoHex = decoded.text ? memoInput.toLowerCase() : chain.encodeCborMemo(memoInput).toString('hex');
    } catch {
      memoHex = chain.encodeCborMemo(memoInput).toString('hex');
    }
  } else {
    memoHex = chain.encodeCborMemo(memoInput).toString('hex');
  }
  const snapshot = await buildSnapshotV2(c, { seller: SELLER, payableId, agentAccount: PAYER_ADDRESS, sponsorAccount: null, signatureThreshold: 1 });
  const now = await chainNow(c);
  const headerExpirySeconds = view.record?.expiresMs
    ? Math.floor((Number(view.record.expiresMs) - 60_000) / 1000)
    : Math.floor((now.slotMs + 3_540_000) / 1000);
  const decision = decide(snapshot, {
    kind: 'transfer', sender: PAYER_ADDRESS, txVersion: 1, sponsor: null, nonce: snapshot.nextNonce,
    recipient: to, amount, token: 'EUDemo', memo: memoHex, headerExpirySeconds, operations: 1,
  }, await ledgerForDecide(`${SELLER}:${payableId}`));
  sendJson(res, 200, {
    decision: decision.decision,
    reason: decision.code,
    plain: decision.decision === 'SIGN'
      ? `The co-signer would approve this transfer (${to.slice(0, 8)}…, ${amount} base units, memo ${memoInput}). Nothing was sent — this is a dry run.`
      : `The co-signer would refuse this transfer (${decision.code}): ${decision.reasons.join('; ')} Nothing was sent — this is a dry run.`,
    tx_sent: false,
  });
}

async function handleAttack(req, res, kind) {
  const ip = clientIp(req);
  const body = await readBody(req).catch(() => ({}));
  if (rejectNonSeller1Write(req, res, body)) return;
  const payableId = Number(body.payable_id);
  const mode = body.mode === 'precheck_only' ? 'precheck_only' : body.mode === 'send_to_chain' ? 'send_to_chain' : undefined;
  if (!Number.isInteger(payableId) || payableId < 1) return badRequest(res, 'payable_id must be a positive integer.');
  if (!['pay_twice', 'wrong_amount', 'unlisted_seller'].includes(kind)) return notFound(res, `Unknown attack kind ${kind}.`);
  // Sends cost a testnet fee: budget them. Prechecks and dry runs do not.
  const willSend = (kind === 'pay_twice' && mode !== 'precheck_only') || (kind === 'wrong_amount');
  if (willSend && kind !== 'wrong_amount') {
    const budget = await hitWindow(`atk:${ip}`, 3_600_000, LIMITS.attackSendsPerHour);
    if (!budget.allowed) return rateLimited(res, Math.ceil(budget.resetMs / 1000), 'The demo’s budget for attack sends is used up for this hour.');
  }
  if (willSend && kind === 'wrong_amount') {
    // Only the CCD wrong-amount sends; the EUDemo one is a dry run.
    const c = await grpc();
    const view = await getPayableOrNull(c, SELLER, payableId);
    if (view?.asset === 'CCD' && view.status === 'Unpaid') {
      const budget = await hitWindow(`atk:${ip}`, 3_600_000, LIMITS.attackSendsPerHour);
      if (!budget.allowed) return rateLimited(res, Math.ceil(budget.resetMs / 1000), 'The demo’s budget for attack sends is used up for this hour.');
    }
  }
  const attempt = await hitWindow(`att:${ip}`, 60_000, LIMITS.attemptsPerMinutePerIp);
  if (!attempt.allowed) return rateLimited(res, Math.ceil(attempt.resetMs / 1000));
  let result;
  if (kind === 'pay_twice') result = await attackPayTwice(payableId, mode);
  else if (kind === 'wrong_amount') result = await attackWrongAmount(payableId);
  else result = await attackUnlistedSeller(payableId);
  sendJson(res, 200, result);
}

async function handleReceipt(req, res, id) {
  const seller = resolveSellerStrict(req, res);
  if (!seller) return;
  const receipt = await buildReceiptFor(id, seller);
  if (!receipt) {
    const c = await grpc();
    const view = await getPayableOrNull(c, seller, id);
    if (!view) return notFound(res, `No payable ${id} is on the test registry <${REGISTRY.index},${REGISTRY.subindex}>.`);
    return notFound(res, `Payable ${id} is ${view.status} — no receipt exists yet.`);
  }
  sendJson(res, 200, receipt);
}

async function handleRecorded(req, res, id) {
  const seller = resolveSellerStrict(req, res);
  if (!seller) return;
  const run = recordedRunFor(id, seller);
  if (!run) return notFound(res, `No recorded run exists for payable ${id}${seller === SELLER2 ? ' (seller 2)' : ''}.`);
  sendJson(res, 200, run);
}

async function handleJudgeFiles(req, res, name) {
  const files = judgeFiles();
  if (!name) return sendJson(res, 200, { files: files.map(({ name: n, url, sha256 }) => ({ name: n, url, sha256 })) });
  const file = files.find((f) => f.name === name);
  if (!file) return notFound(res, `No judge file named ${name}.`);
  const bytes = readFileSync(file.path);
  const type = name.endsWith('.json') ? 'application/json' : name.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/javascript; charset=utf-8';
  res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` });
  res.end(bytes);
}

// ---- workshop fix-back handlers (consent, MCP, buyer agent, balance, CIS-8) ----

async function handleConsentRequest(req, res) {
  const ip = clientIp(req);
  const body = await readBody(req).catch(() => ({}));
  if (rejectNonSeller1Write(req, res, body)) return;
  const payableId = Number(body.payable_id);
  if (!Number.isInteger(payableId) || payableId < 1) return badRequest(res, 'consent/request needs { payable_id }.');
  const budget = await hitWindow(`cns:${ip}`, 3_600_000, 3);
  if (!budget.allowed) {
    return apiError(res, 429, 'budget_exhausted', 'app', 'The demo budget for consent anchors is used up for this hour (3/hour).', { retryable: true, retry_after_s: Math.ceil(budget.resetMs / 1000) });
  }
  const c = await grpc();
  const view = await getPayableOrNull(c, SELLER, payableId);
  if (!view) return notFound(res, `No payable ${payableId} is on the test registry <${REGISTRY.index},${REGISTRY.subindex}>.`);
  if (view.status === 'Paid') return apiError(res, 409, 'already_paid', 'chain', `Payable ${payableId} is already Paid — consent is for an unpaid order.`);
  let record = await consentFor(payableId);
  if (record && record.vraTx && !isConsentExpired(record) && record.status !== 'used') {
    const verified = await verifyConsentVra({ grpcClient: c, record });
    return sendJson(res, 200, { ...publicConsent(record), anchor_verified: verified.ok, already_requested: true });
  }
  if (!record || record.status === 'used' || isConsentExpired(record)) {
    record = buildConsentRecord(view);
  }
  // Anchor the VRA on chain (one registerData tx, owner-signed). A record
  // without its anchor is saved but flagged — the approve/verify paths
  // refuse until the anchor exists.
  try {
    record = await anchorConsentVra({ grpcClient: c, signers, record });
  } catch (e) {
    const { saveConsent } = await import('./store.mjs');
    await saveConsent(record);
    return apiError(res, 503, 'anchor_failed', 'chain', `The consent request was recorded, but its VRA anchor could not be sent (${String(e?.message ?? e).slice(0, 200)}). Retry the request.`, { consent: publicConsent(record), retryable: true });
  }
  return sendJson(res, 201, { ...publicConsent(record), anchor_verified: true });
}

async function handleConsentGet(req, res, id) {
  // Consent state is seller-1-keyed (fix-back §4.4): a ?seller= naming
  // seller 2 is a 400, never a silent seller-1 answer.
  if (rejectNonSeller1Write(req, res)) return;
  const record = await consentFor(id);
  if (!record) {
    return sendJson(res, 200, {
      payable_id: id, status: 'none',
      note: 'No consent request exists for this payable. POST /api/consent/request to create one.',
      lab_anchors: { vra: LAB_CONSENT_ANCHORS.vra, vaa: LAB_CONSENT_ANCHORS.vaa, consent_sha256: LAB_CONSENT_ANCHORS.consentSha256 },
    });
  }
  const c = await grpc();
  const verified = record.vraTx ? await verifyConsentVra({ grpcClient: c, record }) : { ok: false, reason: 'no_anchor' };
  return sendJson(res, 200, { ...publicConsent(record), anchor_verified: verified.ok, anchor_check: verified.reason ?? 'ok' });
}

async function handleConsentApprove(req, res, id) {
  if (rejectNonSeller1Write(req, res)) return;
  const ip = clientIp(req);
  const budget = await hitWindow(`cns:${ip}`, 3_600_000, 3);
  if (!budget.allowed) {
    return apiError(res, 429, 'budget_exhausted', 'app', 'The demo budget for consent anchors is used up for this hour (3/hour).', { retryable: true, retry_after_s: Math.ceil(budget.resetMs / 1000) });
  }
  const record = await consentFor(id);
  if (!record) return notFound(res, `No consent request exists for payable ${id}. Create one first (POST /api/consent/request).`);
  if (record.status === 'approved') return sendJson(res, 200, { ...publicConsent(record), lab_only: true, already_approved: true });
  if (record.status === 'used') return apiError(res, 409, 'consent_used', 'app', `The consent for payable ${id} was already used (one-time use). Request a fresh consent.`);
  if (isConsentExpired(record)) return apiError(res, 409, 'consent_expired', 'app', `The consent for payable ${id} expired (5-minute window). Request a fresh consent.`);
  if (!record.vraTx) return apiError(res, 409, 'no_anchor', 'chain', `The consent for payable ${id} has no VRA anchor on chain yet. Re-request it (POST /api/consent/request).`);
  const c = await grpc();
  try {
    const { record: updated, vaaTx, vaaMethod } = await approveConsentHeadless({ grpcClient: c, signers, record, env: ENV });
    return sendJson(res, 200, { ...publicConsent(updated), lab_only: true, vaa_method: vaaMethod, node_verified: true, note: 'LAB-ONLY approval: the owner presentation was built headlessly in-process from the seed-derived credential. Production approvals arrive as wallet presentations via POST /api/consent/:id/verify-presentation.' });
  } catch (e) {
    return apiError(res, 502, 'approval_failed', 'chain', `The lab-only approval failed: ${String(e?.message ?? e).slice(0, 300)}`, { retryable: true });
  }
}

async function handleConsentVerifyPresentation(req, res, id) {
  const ip = clientIp(req);
  const attempt = await hitWindow(`att:${ip}`, 60_000, LIMITS.attemptsPerMinutePerIp);
  if (!attempt.allowed) return rateLimited(res, Math.ceil(attempt.resetMs / 1000));
  const body = await readBody(req, 64 * 1024).catch(() => null);
  if (rejectNonSeller1Write(req, res, body)) return;
  if (!body || typeof body !== 'object' || !body.presentation || typeof body.presentation !== 'object') {
    return badRequest(res, 'verify-presentation needs { presentation: <VerifiablePresentationV1 JSON> }.');
  }
  const record = await consentFor(id);
  if (!record) return notFound(res, `No consent request exists for payable ${id}. Create one first (POST /api/consent/request).`);
  if (record.status === 'approved') return sendJson(res, 200, { ...publicConsent(record), already_approved: true });
  if (record.status === 'used') return apiError(res, 409, 'consent_used', 'app', `The consent for payable ${id} was already used (one-time use). Request a fresh consent.`);
  if (isConsentExpired(record)) return apiError(res, 409, 'consent_expired', 'app', `The consent for payable ${id} expired (5-minute window). Request a fresh consent.`);
  if (!record.vraTx || !record.requestJson) return apiError(res, 409, 'no_anchor', 'chain', `The consent for payable ${id} has no VRA anchor on chain yet.`);
  let presentation;
  try {
    presentation = VerifiablePresentationV1.fromJSON(body.presentation);
  } catch (e) {
    return badRequest(res, `presentation is not a valid VerifiablePresentationV1 JSON (${String(e?.message ?? e).slice(0, 150)}).`);
  }
  // FIX-BACK-2 (M5, layer 1): pre-validate the presentation's Nonce
  // against THIS payable's stored consentSha256 BEFORE any SDK call —
  // no node verification, no createAndAnchor. A presentation built for a
  // different payable (different Nonce) is refused here as 400
  // valid:false; it never reaches the SDK's un-awaited compareContexts,
  // which is what killed the server twice on the identical replay input.
  try {
    assertPresentationNonceMatches(presentation, record);
  } catch (e) {
    return sendJson(res, 400, { valid: false, reason: String(e.message).slice(0, 300), filed_for_payable: null, stage: 'nonce_prevalidation', note: 'The presentation is valid, but its Nonce does not match this payable\u2019s consent request — it was built for a different consent. Build it against this payable\u2019s anchored request.' });
  }
  const c = await grpc();
  const nodeVerdict = await verifyV1PresentationWithNode(presentation, c);
  if (!nodeVerdict.ok) {
    // Refusal stage 2 — node verification: the presentation does not
    // verify against its OWN embedded request (tampered question, wrong
    // holder, stale proof). Note the handler does NOT verify the
    // presentation against the stored request here; the binding to THIS
    // payable's request is enforced by the Nonce pre-validation above
    // (stage 1) and by assertContextsMatch before the VAA anchor
    // (stage 3) — a presentation for a different consent is refused at
    // stage 1, never here.
    return sendJson(res, 400, { valid: false, reason: nodeVerdict.reason, filed_for_payable: null, stage: 'node_verification', note: 'A presentation for a different consent text, a different holder, or an expired request fails here — the question is hash-bound, so tampering is flagged.' });
  }
  const { VerificationRequestV1 } = await import('@concordium/web-sdk');
  const request = VerificationRequestV1.fromJSON(record.requestJson);
  try {
    const { vaaTx, method } = await anchorConsentVaa({ grpcClient: c, signers, record, request, presentation });
    const { saveConsent } = await import('./store.mjs');
    const updated = { ...record, status: 'approved', approvedAt: new Date().toISOString(), vaaTx };
    await saveConsent(updated);
    return sendJson(res, 200, { ...publicConsent(updated), valid: true, node_verified: true, vaa_method: method });
  } catch (e) {
    // A presentation that passed stages 1–2 but still fails the VAA
    // anchor: assertContextsMatch (stage 3, inside anchorConsentVaa)
    // throws a controlled `context_mismatch:` for a context that does
    // not match the stored request — a client error, not a chain
    // failure. Any other throw is a chain failure (502). The mismatch
    // can no longer reach the SDK's un-awaited compareContexts: it is
    // filtered by the Nonce pre-validation (stage 1) and by
    // assertContextsMatch (stage 3) first, and the process-level
    // unhandledRejection guard is the last line.
    if (String(e?.message ?? '').startsWith('context_mismatch:')) {
      return sendJson(res, 400, { valid: false, reason: String(e.message).slice(0, 300), filed_for_payable: null, stage: 'context_match', note: 'The presentation is valid, but it answers a different consent request (different nonce/context). Build it against this payable\u2019s anchored request.' });
    }
    return apiError(res, 502, 'vaa_anchor_failed', 'chain', `The presentation verified, but its VAA anchor could not be sent (${String(e?.message ?? e).slice(0, 200)}). Nothing was filed; retry.`, { retryable: true });
  }
}

async function handleMcpTools(req, res) {
  try {
    const out = await mcpToolsList();
    return sendJson(res, 200, { url: MCP_URL, network: 'testnet', ...out });
  } catch (e) {
    return apiError(res, 502, 'mcp_unreachable', 'node', `The registry MCP did not answer (${String(e?.message ?? e).slice(0, 200)}).`, { retryable: true });
  }
}

async function handleMcpBadge(req, res, id) {
  if (!id) return badRequest(res, 'badge id (token address or numeric token id) is required.');
  try {
    let tokenAddress = id;
    if (/^\d+$/.test(id)) {
      // Numeric token id: resolve the badge token address via agent_of first.
      const agent = await mcpAgentOf({ tokenId: Number(id) });
      tokenAddress = agent?.payload?.token_address;
      if (!tokenAddress) throw new Error(`agent_of ${id} returned no token_address`);
    }
    const out = await mcpCheckBadge({ id: tokenAddress });
    return sendJson(res, 200, { ...out, token_id: /^\d+$/.test(id) ? Number(id) : undefined });
  } catch (e) {
    return apiError(res, 502, 'mcp_unreachable', 'node', `The registry MCP did not answer (${String(e?.message ?? e).slice(0, 200)}).`, { retryable: true });
  }
}

async function handleBuyerAgentGet(req, res) {
  const record = await buyerAgent();
  if (!record) {
    return sendJson(res, 200, { account: BUYER_ACCOUNT, token_id: null, status: 'not_registered', note: 'The buyer agent is not registered yet. POST /api/buyer-agent/register to mint its CIS-8004 token from the payer account.' });
  }
  return sendJson(res, 200, record);
}

async function handleBuyerAgentRegister(req, res) {
  const ip = clientIp(req);
  const budget = await hitWindow(`reg:${ip}`, 3_600_000, 3);
  if (!budget.allowed) {
    return apiError(res, 429, 'budget_exhausted', 'app', 'The demo budget for agent registrations is used up for this hour (3/hour).', { retryable: true, retry_after_s: Math.ceil(budget.resetMs / 1000) });
  }
  const existing = await buyerAgent();
  if (existing?.tokenId) return sendJson(res, 200, { ...existing, already_registered: true });
  const c = await grpc();
  try {
    const record = await registerBuyerAgent({ grpcClient: c, signers });
    return sendJson(res, 201, record);
  } catch (e) {
    return apiError(res, 502, 'registration_failed', 'chain', `Buyer agent registration failed: ${String(e?.message ?? e).slice(0, 300)}`, { retryable: true });
  }
}

async function handleFulfilmentCheck(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const tokenId = Number(body.buyer_token_id ?? body.token_id);
  const payableId = Number(body.payable_id);
  if (!Number.isInteger(tokenId) || tokenId < 1) return badRequest(res, 'fulfilment/check needs { buyer_token_id }.');
  const expectedOwner = typeof body.expected_owner === 'string' ? body.expected_owner : BUYER_ACCOUNT;
  const c = await grpc();
  const result = await merchantCheckBuyer({ grpcClient: c, tokenId, expectedOwner });
  if (Number.isInteger(payableId) && payableId >= 1) result.payable_id = payableId;
  return sendJson(res, 200, result);
}

async function handleBalanceWatch(req, res) {
  try {
    return sendJson(res, 200, await checkBalances());
  } catch (e) {
    return apiError(res, 503, 'chain_unreachable', 'node', `Balance watch could not read the chain (${String(e?.message ?? e).slice(0, 200)}).`, { retryable: true });
  }
}

async function handleTopUp(req, res) {
  const ip = clientIp(req);
  const budget = await hitWindow(`top:${ip}`, 3_600_000, 3);
  if (!budget.allowed) {
    return apiError(res, 429, 'budget_exhausted', 'app', 'The demo budget for top-ups is used up for this hour (3/hour).', { retryable: true, retry_after_s: Math.ceil(budget.resetMs / 1000) });
  }
  const body = await readBody(req).catch(() => ({}));
  const amount = body.amount_micro_ccd != null ? BigInt(body.amount_micro_ccd) : 50_000_000n;
  const c = await grpc();
  try {
    const out = await topUpPayer({ grpcClient: c, signers, amountMicroCcd: amount });
    return sendJson(res, 200, { ...out, note: 'Owner -> payer top-up (testnet CCD). Record the tx hash; the balance watch reports the new balance.' });
  } catch (e) {
    return apiError(res, 502, 'topup_failed', 'chain', `Top-up failed: ${String(e?.message ?? e).slice(0, 300)}`, { retryable: true });
  }
}

async function handleCis8Status(req, res) {
  const held = externalKeyFromEnv(ENV);
  return sendJson(res, 200, {
    contract: CIS8_CONTRACT,
    seller_token: CIS8_SELLER_TOKEN,
    binding: 'none — no CIS-8 binding exists for token 1476',
    external_key_held: held ? { namespace: held.namespace, key_type: held.key_type, public_key_hex: held.public_key_hex } : null,
    blocked: held ? null : 'No external key is held. The user must supply or generate a real external key (e.g. an Ethereum key the team holds); no key is invented here. See POST /api/cis8/request.',
    badge: 'fully valid without a CIS-8 binding (15/15) — this is a missing cross-chain link, not a validity gap',
  });
}

async function handleCis8Request(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const key = body.key ?? null;
  const proof = body.proof ?? null;
  try {
    const out = await requestCis8Binding({ key, proof, sender: OWNER_ADDRESS, env: ENV });
    return sendJson(res, 200, out);
  } catch (e) {
    return apiError(res, 409, 'cis8_blocked', 'app', String(e?.message ?? e).slice(0, 600), { owner: 'user' });
  }
}

// ---- router ----
const routes = [
  ['GET', /^\/$/, async (req, res) => sendJson(res, 200, {
    service: 'payonce-api', network: NETWORK,
    registry: `<${REGISTRY.index},${REGISTRY.subindex}> (${REGISTRY.name})`,
    endpoints: ['GET /api/config', 'GET /api/health', 'GET /api/stats', 'GET /api/stats/refusals', 'GET /api/invoices', 'GET /api/payables/:id', 'GET /api/payables/:id/document', 'POST /api/payables/:id/verify', 'POST /api/payables', 'POST /api/payables/:id/pay', 'GET /api/jobs/:id', 'GET /api/jobs/:id/events', 'GET /api/tx/:hash/status', 'POST /api/cosigner/dry-run', 'POST /api/attacks/:kind', 'GET /api/receipts/:id', 'GET /api/recorded/:id', 'GET /api/judges/files', 'POST /api/consent/request', 'GET /api/consent/:id', 'POST /api/consent/:id/approve', 'POST /api/consent/:id/verify-presentation', 'GET /api/mcp/tools', 'GET /api/mcp/badge/:id', 'GET /api/buyer-agent', 'POST /api/buyer-agent/register', 'POST /api/fulfilment/check', 'GET /api/balance-watch', 'POST /api/balance-watch/top-up', 'GET /api/cis8/status', 'POST /api/cis8/request', 'GET /api/age-proof/health', 'POST /api/age-proof/policy-check', 'POST /api/age-proof/verify', 'POST /api/age-proof/verify-presentation'],
  })],
  ['GET', /^\/api\/config$/, handleConfig],
  ['GET', /^\/api\/health$/, handleHealth],
  ['GET', /^\/api\/stats$/, handleStats],
  ['GET', /^\/api\/invoices$/, handleInvoices],
  ['GET', /^\/api\/payables\/(\d+)$/, (req, res, m) => handleGetPayable(req, res, Number(m[1]))],
  ['GET', /^\/api\/payables\/(\d+)\/document$/, (req, res, m) => handleDocument(req, res, Number(m[1]))],
  ['POST', /^\/api\/payables\/(\d+)\/verify$/, (req, res, m) => handleVerify(req, res, Number(m[1]))],
  ['POST', /^\/api\/payables$/, handleCreatePayable],
  ['POST', /^\/api\/payables\/(\d+)\/pay$/, (req, res, m) => handlePay(req, res, Number(m[1]))],
  ['GET', /^\/api\/jobs\/([^/]+)$/, (req, res, m) => handleGetJob(req, res, decodeURIComponent(m[1]))],
  ['GET', /^\/api\/jobs\/([^/]+)\/events$/, (req, res, m) => handleJobEvents(req, res, decodeURIComponent(m[1]))],
  ['GET', /^\/api\/tx\/([^/]+)\/status$/, (req, res, m) => handleTxStatus(req, res, m[1])],
  ['POST', /^\/api\/cosigner\/dry-run$/, handleDryRun],
  ['POST', /^\/api\/attacks\/([^/]+)$/, (req, res, m) => handleAttack(req, res, m[1])],
  ['GET', /^\/api\/receipts\/(\d+)$/, (req, res, m) => handleReceipt(req, res, Number(m[1]))],
  ['GET', /^\/api\/payables\/(\d+)\/receipt$/, (req, res, m) => handleReceipt(req, res, Number(m[1]))],
  ['GET', /^\/api\/recorded\/(\d+)$/, (req, res, m) => handleRecorded(req, res, Number(m[1]))],
  ['GET', /^\/api\/judges\/files$/, (req, res) => handleJudgeFiles(req, res, null)],
  ['GET', /^\/api\/judges\/files\/([^/]+)$/, (req, res, m) => handleJudgeFiles(req, res, decodeURIComponent(m[1]))],
  ['GET', /^\/api\/age-proof\/health$/, (req, res) => ageProof.handleHealth(req, res)],
  ['POST', /^\/api\/age-proof\/policy-check$/, (req, res) => ageProof.handlePolicyCheck(req, res)],
  ['POST', /^\/api\/age-proof\/verify$/, (req, res) => ageProof.handleVerify(req, res)],
  ['POST', /^\/api\/age-proof\/verify-presentation$/, (req, res) => ageProof.handleVerifyPresentation(req, res)],
  ['POST', /^\/api\/consent\/request$/, handleConsentRequest],
  ['GET', /^\/api\/consent\/(\d+)$/, (req, res, m) => handleConsentGet(req, res, Number(m[1]))],
  ['POST', /^\/api\/consent\/(\d+)\/approve$/, (req, res, m) => handleConsentApprove(req, res, Number(m[1]))],
  ['POST', /^\/api\/consent\/(\d+)\/verify-presentation$/, (req, res, m) => handleConsentVerifyPresentation(req, res, Number(m[1]))],
  ['GET', /^\/api\/mcp\/tools$/, handleMcpTools],
  ['GET', /^\/api\/mcp\/badge\/([^/]+)$/, (req, res, m) => handleMcpBadge(req, res, decodeURIComponent(m[1]))],
  ['GET', /^\/api\/buyer-agent$/, handleBuyerAgentGet],
  ['POST', /^\/api\/buyer-agent\/register$/, handleBuyerAgentRegister],
  ['POST', /^\/api\/fulfilment\/check$/, handleFulfilmentCheck],
  ['GET', /^\/api\/balance-watch$/, handleBalanceWatch],
  ['POST', /^\/api\/balance-watch\/top-up$/, handleTopUp],
  ['GET', /^\/api\/cis8\/status$/, handleCis8Status],
  ['POST', /^\/api\/cis8\/request$/, handleCis8Request],
];

const server = createServer(async (req, res) => {
  try {
    await ready();
  } catch (e) {
    return internal(res, new Error(`store unavailable: ${e.message}`));
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const m = url.pathname.match(pattern);
      if (m) return await handler(req, res, m);
    }
    return notFound(res, `No route ${req.method} ${url.pathname}.`);
  } catch (e) {
    if (e?.message === 'body too large' || e?.message === 'invalid JSON body') return badRequest(res, e.message);
    if (isNodeError(e)) return chainUnreachable(res, e);
    return internal(res, e);
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ready().then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`payonce-api listening on http://${HOST}:${PORT} (registry <${REGISTRY.index},${REGISTRY.subindex}>, ${NETWORK})`);
    });
  }).catch((e) => {
    console.error(`[startup] FATAL: store init failed: ${e.message}`);
    process.exit(1);
  });
}

export { server, resolveWriteSeller, handleStats, handleStatsRefusals, handleInvoices, handleGetPayable, handleDocument, payableFacts, rejectNonSeller1Write };
