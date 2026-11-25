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
import { readFileSync } from 'node:fs';
import { CredentialRegistrationId } from '@concordium/web-sdk';
import { backend } from './backend.mjs';
import {
  grpc, chainNow, getPayable, getPayableOrNull, getConfig as getChainConfig,
  getVendor, getAccount, getTx, getRegistryBalance, getBlockTime, microCcdOf,
  sendUpdate, waitFinalized, signers, updatedEvent, SELLER, PAYER,
} from './chain-v2.mjs';
import { verifyBeforePay, verifyCcdV2, verifyPltV2 } from './verifier-v2.mjs';
import { buildSnapshotV2 } from './snapshot-v2.mjs';
import { createOrReturnJob, runJob, subscribeJob, unsubscribeJob, rejectInfo, rejectOf, feeOf } from './jobs.mjs';
import { attackPayTwice, attackWrongAmount, attackUnlistedSeller } from './attacks.mjs';
import { buildReceiptFor, paymentTxsFor } from './receipts.mjs';
import {
  docForPayable, generateLabDocument, storeDocument, recordedRunFor,
  recordedRefusals, judgeFiles,
} from './docs.mjs';
import {
  loadJobs, loadCounters, saveCounters,
  hitWindow, leftInWindow,
} from './store.mjs';
import { initStore } from './db.mjs';
import { listableRows, statsBody } from './listable.mjs';
import { reconcile } from './reconcile.mjs';
import { ledgerForDecide } from './ledger.mjs';
import {
  createAgeProofHandlers, ageGateCheck,
} from './age-proof.mjs';
import {
  REGISTRY, CIS8004_OFFICIAL, RESERVATION_SECS, CO_SIGNER_MARGIN_SECS,
  OWNER_TOKEN, OWNER_ADDRESS, PAYER_ADDRESS, PAYEE_CCD, PAYEE_EUDEMO,
  FRESH_CCD_MICRO, FRESH_EUDEMO_BASE, FRESH_DUE_HOURS,
  LIMITS, PORT, HOST, NETWORK, EXPLORER_TX, EXPLORER_INSTANCE,
  txUrl, instanceUrl, fmtCcd, fmtEudemo, shortHash,
} from './config.mjs';

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
      const summary = await reconcile();
      console.log(`[startup] reconcile: ${summary.line}`);
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
async function knownIds() {
  const counters = await loadCounters();
  return [...new Set([...KNOWN_IDS, ...(counters.freshIds ?? [])])].sort((a, b) => a - b);
}

let statsCache = null;
async function scanPayables(c) {
  const rows = [];
  for (const id of await knownIds()) {
    try {
      const view = await getPayableOrNull(c, SELLER, id);
      if (view) rows.push(view);
    } catch { /* one unreadable row does not fail the scan */ }
  }
  return rows;
}

function amountDisplay(view) {
  return view.asset === 'CCD'
    ? `${(Number(view.amount) / 1e6).toFixed(6)} CCD`
    : `${(Number(view.amount) / 1e6).toFixed(2)} EUDemo`;
}

function labelFor(view) {
  const base = view.id >= 1000 || view.id === 10 || view.id === 11
    ? 'Lab invoice (testnet, not a real invoice)'
    : 'Contract-matrix test payable (testnet)';
  // The P3 facts type has no voided variant: the real status is surfaced
  // in the label, and the verify endpoint (the enforcement point) reports
  // the voided status and blocks payment.
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
    const approval = await getVendor(c, PAYER_ADDRESS, OWNER_ADDRESS);
    configCache.vendorList = approval
      ? [{ seller: OWNER_ADDRESS, label: 'Lab seller account (demo seller)' }]
      : [];
  } catch {
    configCache.vendorList = [{ seller: OWNER_ADDRESS, label: 'Lab seller account (demo seller)' }];
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
    build: {
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

async function handleStats(req, res) {
  const now = Date.now();
  if (statsCache && now - statsCache.at < 20_000) return sendJson(res, 200, statsCache.body);
  const c = await grpc();
  const rows = await scanPayables(c);
  const counters = await loadCounters();
  const refusedHashes = new Set([...recordedRefusals().keys(), ...counters.liveRefusals.map((r) => r.txHash)]);
  // Reconciled at source: the total counts the same listable rows the
  // /api/invoices list shows (never the raw scanned rows).
  const body = statsBody({ rows, refusedCount: refusedHashes.size, lastVerifierRunAt: counters.lastVerifierRunAt });
  statsCache = { at: now, body };
  sendJson(res, 200, body);
}

async function handleInvoices(req, res) {
  const c = await grpc();
  const rows = await scanPayables(c);
  const items = listableRows(rows)
    .sort((a, b) => a.id - b.id)
    .map((r) => ({
      payable_id: r.id,
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
          : { kind: 'unpaid' },
    agent: { registry: { index: CIS8004_OFFICIAL.index, subindex: CIS8004_OFFICIAL.subindex }, token: view.agentToken },
    doc_sha256: view.docHash,
    label: labelFor(view),
  };
}

async function handleGetPayable(req, res, id) {
  const c = await grpc();
  const view = await getPayableOrNull(c, SELLER, id);
  if (!view) return notFound(res, `No payable ${id} is on the test registry <${REGISTRY.index},${REGISTRY.subindex}>.`);
  const now = await chainNow(c);
  sendJson(res, 200, await payableFacts(c, view, now.slotMs));
}

async function handleDocument(req, res, id) {
  const c = await grpc();
  const view = await getPayableOrNull(c, SELLER, id);
  if (!view) return notFound(res, `No payable ${id} is on the test registry <${REGISTRY.index},${REGISTRY.subindex}>.`);
  const doc = await docForPayable(id);
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
  const c = await grpc();
  const view = await getPayableOrNull(c, SELLER, id);
  if (!view) return notFound(res, `No payable ${id} is on the test registry <${REGISTRY.index},${REGISTRY.subindex}>.`);
  const now = await chainNow(c);
  const docBytes = docSha256 ? null : await docForPayable(id);
  const { chain } = await backend();
  const payerInfo = await getAccount(c, PAYER_ADDRESS);
  const payerBalances = {
    ccdAvailableMicro: microCcdOf(payerInfo.accountAvailableBalance ?? payerInfo.accountAmount),
    eudemoBase: chain.tokenBalance(payerInfo, 'EUDemo'),
  };

  if (mode === 'before_pay') {
    const result = await verifyBeforePay(c, { view, docBytes, docSha256, chainTimeMs: now.slotMs, payerBalances });
    const counters = await loadCounters();
    counters.verifierRuns += 1;
    if (result.allPass) counters.verifierPassed += 1; else counters.verifierFailed += 1;
    counters.lastVerifierRunAt = new Date().toISOString();
    await saveCounters(counters);
    return sendJson(res, 200, {
      payable_id: id, mode, verdict: result.verdict,
      passed: result.passed, total: result.total,
      blocked_reason: result.blockedReason, checks: result.checks,
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
    : txs.find(([l]) => l === 'Transfer')?.[1];
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
  const counters = await loadCounters();
  counters.verifierRuns += 1;
  if (result.allPass) counters.verifierPassed += 1; else counters.verifierFailed += 1;
  counters.lastVerifierRunAt = new Date().toISOString();
  await saveCounters(counters);
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
  const counters = await loadCounters();
  const id = counters.nextFreshId;
  const amount = asset === 'ccd' ? FRESH_CCD_MICRO : FRESH_EUDEMO_BASE;
  const payee = asset === 'ccd' ? PAYEE_CCD : PAYEE_EUDEMO;
  const dueMs = Date.now() + FRESH_DUE_HOURS * 3_600_000;
  const docText = generateLabDocument({ id, asset: asset === 'ccd' ? 'CCD' : 'EUDemo', amount: amount.toString(), payee, seller: SELLER, due: dueMs });
  const docHash = await storeDocument(id, docText);
  const sig = await signers();
  let sent;
  try {
    sent = await sendUpdate(c, {
      from: sig.owner, receiveName: 'register_payable',
      parameterHex: v2enc.encodeV2RegisterPayable({
        id, payee, amount: amount.toString(), asset: asset === 'ccd' ? 'CCD' : 'EUDemo',
        dueMs, docHashHex: docHash, token: OWNER_TOKEN, expected: PAYER_ADDRESS, legal: null,
      }),
      maxEnergy: 6000n,
    });
  } catch (e) {
    return chainUnreachable(res, e);
  }
  const status = await waitFinalized(c, sent.txHash);
  const rr = rejectOf(status);
  if (rr) {
    const info = rejectInfo(rr.rejectReason);
    const counters2 = await loadCounters();
    counters2.liveRefusals.push({ txHash: sent.txHash, code: info.code, at: new Date().toISOString() });
    await saveCounters(counters2);
    return apiError(res, 409, 'chain_refused', 'chain', `The chain refused the registration (${info.code} ${info.name}).`, { reject: info, fee_testnet_ccd: feeOf(status), tx_hash: sent.txHash, explorer_url: txUrl(sent.txHash) });
  }
  counters.nextFreshId = id + 1;
  counters.freshIds = [...(counters.freshIds ?? []), id];
  await saveCounters(counters);
  statsCache = null;
  sendJson(res, 201, {
    payable_id: id,
    tx_hash: sent.txHash,
    explorer_url: txUrl(sent.txHash),
    fee_testnet_ccd: feeOf(status) ?? '0',
    due: new Date(dueMs).toISOString(),
  });
}

async function handlePay(req, res, id) {
  const ip = clientIp(req);
  const body = await readBody(req).catch(() => ({}));
  const rail = body.rail === 'eudemo' ? 'eudemo' : body.rail === 'ccd' ? 'ccd' : null;
  if (!rail) return badRequest(res, 'rail must be "ccd" or "eudemo".');
  const docSha256 = typeof body.doc_sha256 === 'string' ? body.doc_sha256 : null;
  const attempt = await hitWindow(`att:${ip}`, 60_000, LIMITS.attemptsPerMinutePerIp);
  if (!attempt.allowed) return rateLimited(res, Math.ceil(attempt.resetMs / 1000));
  const c = await grpc();
  const view = await getPayableOrNull(c, SELLER, id);
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
  const { job, created } = await createOrReturnJob(id, rail);
  if (created) void runJob(job);
  sendJson(res, 200, {
    job_id: job.job_id, payable_id: job.payable_id, rail: job.rail,
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
  const receipt = await buildReceiptFor(id);
  if (!receipt) {
    const c = await grpc();
    const view = await getPayableOrNull(c, SELLER, id);
    if (!view) return notFound(res, `No payable ${id} is on the test registry <${REGISTRY.index},${REGISTRY.subindex}>.`);
    return notFound(res, `Payable ${id} is ${view.status} — no receipt exists yet.`);
  }
  sendJson(res, 200, receipt);
}

async function handleRecorded(req, res, id) {
  const run = recordedRunFor(id);
  if (!run) return notFound(res, `No recorded run exists for payable ${id}.`);
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

// ---- router ----
const routes = [
  ['GET', /^\/$/, async (req, res) => sendJson(res, 200, {
    service: 'payonce-api', network: NETWORK,
    registry: `<${REGISTRY.index},${REGISTRY.subindex}> (${REGISTRY.name})`,
    endpoints: ['GET /api/config', 'GET /api/health', 'GET /api/stats', 'GET /api/invoices', 'GET /api/payables/:id', 'GET /api/payables/:id/document', 'POST /api/payables/:id/verify', 'POST /api/payables', 'POST /api/payables/:id/pay', 'GET /api/jobs/:id', 'GET /api/jobs/:id/events', 'GET /api/tx/:hash/status', 'POST /api/cosigner/dry-run', 'POST /api/attacks/:kind', 'GET /api/receipts/:id', 'GET /api/recorded/:id', 'GET /api/judges/files', 'GET /api/age-proof/health', 'POST /api/age-proof/policy-check', 'POST /api/age-proof/verify', 'POST /api/age-proof/verify-presentation'],
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
    return internal(res, e);
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  ready().then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`payonce-api listening on http://${HOST}:${PORT} (registry <${REGISTRY.index},${REGISTRY.subindex}>, ${NETWORK})`);
    });
  }).catch((e) => {
    console.error(`[startup] FATAL: store init failed: ${e.message}`);
    process.exit(1);
  });
}

export { server };
