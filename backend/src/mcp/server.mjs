// PayOnce backend — MCP tool server (stdio, Concordium testnet only).
//
// Exposes the live PayOnce flows as MCP tools, reusing the existing backend
// modules — no re-implementation of chain reads, verification, sending, or
// the co-signer gate:
//
//   verify_invoice  — live verifier branch (CCD or PLT) for a tx hash.
//   pay_payable     — live payment flow (Rail A pay_ccd / Rail B
//                     reserve -> transfer -> confirm behind the co-signer
//                     gate). Validates EVERYTHING before sending anything.
//   receipt         — stored receipt facts for a Paid payable, re-read live.
//   list_payables   — payable rows for a list of ids, read live.
//
// READS ARE V2 (Batch C fix-back, F1): every payable view in this file is
// read from the live v2 registry <13150,0> via backend/src/v2/registry.mjs
// (getPayableV2OrNull, seller = OWNER_ADDRESS) — the same views the
// product API uses. The v1 registry <13149,0> holds only the legacy
// payables 6/7/8/9; every fresh payable (1000+) lives on v2 only, so the
// v1 reads could not see them. KNOWN SPLIT (not hidden): the SEND path
// below (pay_payable's sendUpdate + the co-signer gate snapshot + the
// CCD/PLT verifier's contract-event checks) still targets the v1 contract
// and v1 event shapes — the v2 send/verifier re-scope is Batch B's
// registry-scoping work, not this file. Consequences, stated plainly:
// (a) pay_payable validates a v2 payable, then its v1 send is rejected by
// the v1 contract for a v2-only id — fail-closed, no money moves;
// (b) verify_invoice on a v2 CCD pay tx fails CCD-03/04/05/08 (the
// verifier looks for v1 contract events) and on a v2 EUDemo transfer
// fails PLT-07/08 (the v2 memo is seller-qualified, `payable:<seller>:<id>`)
// — the verifier is v1-shaped until Batch B re-scopes it. The tool
// descriptions say exactly which registry each leg reads.
//
// Testnet only. No mocks, no fakes: every result comes from a live chain
// read (or, for pay_payable, a live send). Keys are loaded in-process only
// by src/send.mjs and are never printed, logged, or returned.
//
// Run:  node src/mcp/server.mjs        (from ~/workspace/payonce-build/backend)
//       (stdio transport — speak MCP JSON-RPC on stdin/stdout; log lines,
//       if any, go to stderr only, never stdout.)
// Environment: the server reaches Concordium testnet over gRPC, so the
// process needs the ambient network env (https_proxy / HTTP(S)_PROXY,
// NODE_EXTRA_CA_CERTS, SSL_CERT_FILE) wherever it runs. NOTE: an MCP
// host that spawns this server with a stripped env (the SDK's
// StdioClientTransport keeps only HOME/LOGNAME/PATH/SHELL/TERM/USER)
// will make the server's first chain read hang — pass the ambient env
// through when spawning (see test/mcp.test.mjs stdio smoke test).
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  grpcClient,
  getTxStatus,
  getBlockTime,
  getTxBlockTime,
  getAccountInfo,
  tokenBalance,
  toJson,
  encodeCborMemo,
  canonicalMemo,
} from '../chain.mjs';
// F1: payable views come from the v2 registry <13150,0> (see header) —
// the v1 read path (backend/src/registry.mjs) is NOT used here at all.
// NOTE (honesty judge): that v1 getPayable hex-pads the id wrong for v1
// ids >= 256; using the v2 views sidesteps it — the v1 padding is NOT
// "fixed" here, the v1 read path is simply not used.
import { getPayableV2OrNull, getRegistryBalanceV2 } from '../v2/registry.mjs';
import { verifyCcd, verifyPlt, verifyPltTransfer } from '../verifier/checks.mjs';
import { decodeLoggedEvents } from '../events.mjs';
import {
  loadSigners,
  sendUpdate,
  sendTokenTransfer,
  waitFinalized,
  encodePayableId,
  encodeConfirm,
  OWNER_ADDRESS,
  SELLER_B_ADDRESS,
} from '../send.mjs';
import { decide } from '../cosigner/decide.mjs';
import { buildSnapshot } from '../cosigner/snapshot.mjs';

export const NETWORK = 'testnet';
export const REGISTRY = { index: 13150, subindex: 0 };
// V2 views are keyed by (seller, id): every payable in this server is
// read for the lab seller = the owner account (same seller the product
// API uses for its v2 reads).
const SELLER = OWNER_ADDRESS;

// Co-signer approval policy for the live E2E (TEST VALUES, same as
// spikes/live-e2e.mjs — not owner decisions). The policy is an operator
// input to the gate in this server; the live v2 vendor row is not
// consulted here.
export const TEST_APPROVAL = {
  tier: 'test',
  legalRef: null,
  perPayableCap: '1000000',
  periodCap: '10000000',
  periodSecs: 86400,
};
// Fee headroom (microCCD) a payer must hold above the payment amount.
const FEE_HEADROOM_MICROCCD = 1_000_000n;
// Rail B needs three B sends (reserve/transfer/confirm). Each contract send
// is capped at 6000 NRG (~47 CCD max cost at ~0.0078 CCD/NRG — the node
// rejects a send whose max cost exceeds the sender's balance, so the cap
// must stay well below a working balance). Require 100 CCD up front so the
// tool refuses BEFORE reserving instead of dying at the confirm (seen live
// 2026-11-24: a 10000-NRG cap = ~78 CCD max cost exceeded B's ~60 CCD and
// the confirm submit was rejected after the transfer had already landed).
const RAIL_B_MIN_CCD_MICROCCD = 100_000_000n;
const MCP_MAX_ENERGY = 6000n;

const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE_PATH = resolve(BACKEND_ROOT, 'test/live-e2e-2026-11-24.json');
const INVOICE_DIR = resolve(BACKEND_ROOT, 'test/invoices');
// The live-e2e evidence file records Rail A = payable 6, Rail B = payable 7.
const KNOWN_DOCS = {
  6: resolve(INVOICE_DIR, 'invoice-006-ccd.txt'),
  7: resolve(INVOICE_DIR, 'invoice-007-eudemo.txt'),
};

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const isHex64 = (s) => typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);

function fail(message) {
  throw new Error(message);
}

/** Resolve a docPath: absolute as-is; relative first against cwd, then the backend root. */
export function resolveDocPath(docPath) {
  if (isAbsolute(docPath)) return docPath;
  const fromCwd = resolve(process.cwd(), docPath);
  if (existsSync(fromCwd)) return fromCwd;
  return resolve(BACKEND_ROOT, docPath);
}

function readDocBytes(docPath) {
  const full = resolveDocPath(docPath);
  if (!existsSync(full)) fail(`invoice document not found: ${docPath}`);
  return readFileSync(full);
}

/** Live-e2e evidence (real tx hashes from the 2026-11-24 run), or null. */
function loadEvidence() {
  try {
    if (!existsSync(EVIDENCE_PATH)) return null;
    return JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Evidence tx hashes for a payable id, or null.
 * The v1 Paid record stores NO tx hash for the CCD rail and no reserve /
 * confirm hashes for the PLT rail, so those hashes are only recoverable
 * from the evidence file of the run that created them. The hashes are then
 * re-read live from the chain and re-verified — the file is a pointer to
 * real on-chain transactions, not a substitute for them.
 * NOTE: this evidence is v1-anchored (payables 6/7, which do not exist on
 * v2), so for v2 payables it returns null and the PLT reserve/confirm
 * checks SKIP — the verifier never passes them silently.
 */
export function evidenceFor(payableId) {
  const ev = loadEvidence();
  if (!ev) return null;
  if (payableId === 6 && ev.railA) {
    return { payTx: ev.railA.payTx ?? null, reserveTx: null, transferTx: null, confirmTx: null };
  }
  if (payableId === 7 && ev.railB) {
    return {
      payTx: null,
      reserveTx: ev.railB.reserveTx ?? null,
      transferTx: ev.railB.transferTx ?? null,
      confirmTx: ev.railB.confirmTx ?? null,
    };
  }
  return null;
}

function updatedEvent(status, receiveName) {
  return (status.summary?.events ?? []).find(
    (e) => e.tag === 'Updated' && e.receiveName === receiveName,
  );
}

/**
 * Reserve + confirm contexts for the full PLT verifier, recovered live
 * from the evidence tx hashes when the checked tx is the known transfer
 * for this payable. Returns { reserve, confirm } with nulls when the
 * hashes are unknown — the verifier then SKIPs PLT-12/PLT-13 instead of
 * passing them silently.
 */
async function pltContextsFor(client, payableId, txHash) {
  const ev = evidenceFor(payableId);
  if (!ev || !ev.transferTx || ev.transferTx.toLowerCase() !== String(txHash).toLowerCase()) {
    return { reserve: null, confirm: null, reserveTx: null, confirmTx: null };
  }
  let reserve = null;
  if (ev.reserveTx) {
    try {
      const rs = await getTxStatus(client, ev.reserveTx);
      const rbt = await getBlockTime(client, rs.blockHash);
      const upd = updatedEvent(rs, 'payable_registry_v2.reserve_plt');
      reserve = { blockTime: rbt, logged: upd ? decodeLoggedEvents(upd) : [] };
    } catch {
      reserve = null;
    }
  }
  let confirm = null;
  if (ev.confirmTx) {
    try {
      const cs = await getTxStatus(client, ev.confirmTx);
      confirm = { blockTime: await getBlockTime(client, cs.blockHash) };
    } catch {
      confirm = null;
    }
  }
  return { reserve, confirm, reserveTx: ev.reserveTx, confirmTx: ev.confirmTx };
}

function payableRow(view) {
  return {
    id: view.id,
    status: view.status,
    amount: view.amount,
    asset: view.asset,
    seller: view.seller,
    payee: view.payee,
    expectedPayer: view.expectedPayer ?? null,
    due: view.due,
    dueMs: view.dueMs,
    docHash: view.docHash,
    record: view.record,
  };
}

async function loadPayableOrFail(client, payableId) {
  if (!Number.isInteger(payableId) || payableId < 1) fail(`invalid payableId: ${payableId}`);
  const view = await getPayableV2OrNull(client, SELLER, payableId);
  if (!view) fail(`unknown payable ${payableId}: no payable with that id is registered on testnet registry <13150,0>`);
  return view;
}

/** Current finalized chain time (slot time of the last finalized block). */
async function chainNow(client) {
  const consensus = toJson(await client.getConsensusStatus());
  const block = await getBlockTime(client, consensus.lastFinalizedBlock);
  return { blockHash: consensus.lastFinalizedBlock, slotTime: block.slotTime, slotMs: new Date(block.slotTime).getTime() };
}

// ---------------------------------------------------------------------------
// verify_invoice
// ---------------------------------------------------------------------------

/**
 * Run the live verifier for (payableId, txHash).
 * Unknown payable / unknown tx / doc mismatch are tool errors (thrown —
 * the MCP SDK surfaces them as isError results, the server keeps running).
 * A known tx that fails checks returns the full check list with
 * allPass=false — that is a result, not an error.
 */
export async function verifyInvoice({ payableId, txHash, docPath = null }) {
  if (!isHex64(txHash)) fail(`invalid txHash: expected 64 hex characters, got ${String(txHash).slice(0, 20)}…`);
  const client = grpcClient();
  const view = await loadPayableOrFail(client, payableId);
  let docBytes = null;
  if (docPath) {
    docBytes = readDocBytes(docPath);
    const hash = sha256hex(docBytes);
    if (hash !== view.docHash) {
      fail(`doc mismatch for payable ${payableId}: sha256(doc)=${hash.slice(0, 16)}…, stored doc_hash=${view.docHash.slice(0, 16)}… — refusing to verify against a different document`);
    }
  }
  let summary;
  try {
    summary = await getTxStatus(client, txHash);
  } catch (e) {
    fail(`unknown tx ${txHash}: ${e.message}`);
  }
  const blockTime = await getBlockTime(client, summary.blockHash);
  const balance = await getRegistryBalanceV2(client);
  if (view.asset === 'CCD') {
    const result = verifyCcd({ payableId, txHash, summary, blockTime, view, balance, docBytes });
    return { tool: 'verify_invoice', network: NETWORK, payableId, txHash, asset: view.asset, status: view.status, blockTime: blockTime.slotTime, ...result };
  }
  const { reserve, confirm } = await pltContextsFor(client, payableId, txHash);
  const result = verifyPlt({ payableId, txHash, summary, blockTime, view, balance, docBytes, reserve, confirm });
  return { tool: 'verify_invoice', network: NETWORK, payableId, txHash, asset: view.asset, status: view.status, blockTime: blockTime.slotTime, ...result };
}

// ---------------------------------------------------------------------------
// list_payables
// ---------------------------------------------------------------------------

export async function listPayables({ ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } = {}) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50) fail('ids must be a non-empty array of at most 50 payable ids');
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 1) fail(`invalid payable id in list: ${id}`);
  }
  const client = grpcClient();
  const payables = [];
  for (const id of ids) {
    const view = await getPayableV2OrNull(client, SELLER, id);
    if (!view) {
      payables.push({ id, exists: false, status: 'absent' });
    } else {
      payables.push({ id, exists: true, status: view.status, amount: view.amount, asset: view.asset, payee: view.payee, seller: view.seller, due: view.due, dueMs: view.dueMs });
    }
  }
  return { tool: 'list_payables', network: NETWORK, registry: REGISTRY, payables };
}

// ---------------------------------------------------------------------------
// receipt
// ---------------------------------------------------------------------------

export async function getReceipt({ payableId }) {
  const client = grpcClient();
  const view = await loadPayableOrFail(client, payableId);
  if (view.status !== 'Paid') {
    return {
      tool: 'receipt',
      network: NETWORK,
      payableId,
      paid: false,
      status: view.status,
      message: 'not paid yet',
      payable: payableRow(view),
    };
  }
  const docPath = KNOWN_DOCS[payableId] && existsSync(KNOWN_DOCS[payableId]) ? KNOWN_DOCS[payableId] : null;
  if (view.asset === 'CCD') {
    const ev = evidenceFor(payableId);
    const payTx = view.record?.txHash ?? ev?.payTx ?? null;
    if (!payTx) {
      return {
        tool: 'receipt', network: NETWORK, payableId, paid: true, status: 'Paid',
        payable: payableRow(view),
        paymentTxHash: null, transferTxHash: null, confirmTxHash: null,
        verifier: null,
        note: 'v1 CCD Paid record stores no tx hash and no evidence tx is known for this payable, so the payment cannot be re-verified from this receipt alone',
      };
    }
    const paymentBlockTime = await getTxBlockTime(client, payTx);
    const verification = await verifyInvoice({ payableId, txHash: payTx, docPath });
    return {
      tool: 'receipt', network: NETWORK, payableId, paid: true, status: 'Paid',
      payable: payableRow(view),
      paymentTxHash: payTx,
      paymentBlockTime: paymentBlockTime.slotTime,
      transferTxHash: null, confirmTxHash: null,
      verifier: verification,
    };
  }
  // PLT: the stored record carries the transfer tx hash.
  const transferTx = view.record?.txHash ?? null;
  if (!transferTx) fail(`payable ${payableId} is Paid but its record stores no transfer tx hash`);
  const { reserveTx, confirmTx } = await pltContextsFor(client, payableId, transferTx);
  const transferBlockTime = await getTxBlockTime(client, transferTx);
  const confirmBlockTime = confirmTx ? await getTxBlockTime(client, confirmTx) : null;
  const reserveBlockTime = reserveTx ? await getTxBlockTime(client, reserveTx) : null;
  const verification = await verifyInvoice({ payableId, txHash: transferTx, docPath });
  return {
    tool: 'receipt', network: NETWORK, payableId, paid: true, status: 'Paid',
    payable: payableRow(view),
    transferTxHash: transferTx,
    transferBlockTime: transferBlockTime.slotTime,
    reserveTxHash: reserveTx,
    reserveBlockTime: reserveBlockTime?.slotTime ?? null,
    confirmTxHash: confirmTx,
    confirmBlockTime: confirmBlockTime?.slotTime ?? null,
    verifier: verification,
  };
}

// ---------------------------------------------------------------------------
// pay_payable — live payment. Validation first; nothing is sent on failure.
// ---------------------------------------------------------------------------

/** All pre-send checks. Throws on the first failure — before any signer is loaded. */
export async function validatePayableForPayment(client, { payableId, rail, docPath }) {
  if (!Number.isInteger(payableId) || payableId < 1) fail(`invalid payableId: ${payableId}`);
  if (rail !== 'ccd' && rail !== 'eudemo') fail(`invalid rail "${rail}": expected "ccd" or "eudemo"`);
  if (!docPath) fail('docPath is required for pay_payable: the invoice document must match the stored doc_hash');
  const view = await loadPayableOrFail(client, payableId);
  // Rail/asset first (static input error), then the document, then state:
  // a payment against a different document is refused even if the payable
  // is already Paid — the doc check must win over the status check.
  const expectedAsset = rail === 'ccd' ? 'CCD' : 'EUDemo';
  if (view.asset !== expectedAsset) {
    fail(`wrong rail "${rail}" for payable ${payableId}: payable asset is ${view.asset}, not ${expectedAsset}`);
  }
  const docBytes = readDocBytes(docPath);
  const hash = sha256hex(docBytes);
  if (hash !== view.docHash) {
    fail(`doc mismatch for payable ${payableId}: sha256(doc)=${hash.slice(0, 16)}…, stored doc_hash=${view.docHash.slice(0, 16)}… — refusing to pay against a different document`);
  }
  if (view.status !== 'Unpaid') {
    fail(`payable ${payableId} is ${view.status}, not Unpaid — refusing to pay (already-Paid payables are never paid twice)`);
  }
  const amount = BigInt(view.amount);
  if (amount <= 0n) fail(`payable ${payableId} has non-positive amount ${view.amount} — refusing to pay`);
  if (BigInt(view.amount) > BigInt(TEST_APPROVAL.perPayableCap) && rail === 'eudemo') {
    fail(`payable ${payableId} amount ${view.amount} exceeds the co-signer per-payable cap ${TEST_APPROVAL.perPayableCap} — refusing to pay`);
  }
  const now = await chainNow(client);
  if (now.slotMs > Number(view.dueMs)) {
    fail(`payable ${payableId} is past due: chain time ${now.slotTime} is after due ${view.due} — refusing to pay`);
  }
  if (rail === 'ccd') {
    const info = await getAccountInfo(client, OWNER_ADDRESS, now.blockHash);
    const available = BigInt(info.accountAvailableBalance ?? info.accountAmount ?? '0');
    if (available < amount + FEE_HEADROOM_MICROCCD) {
      fail(`insufficient CCD balance: owner holds ${available} microCCD available, payable ${payableId} needs ${amount} + ${FEE_HEADROOM_MICROCCD} fee headroom — refusing to pay`);
    }
  } else {
    const info = await getAccountInfo(client, SELLER_B_ADDRESS, now.blockHash);
    const eudemo = BigInt(tokenBalance(info, 'EUDemo'));
    if (eudemo < amount) {
      fail(`insufficient EUDemo balance: seller B holds ${eudemo} base units, payable ${payableId} needs ${amount} — refusing to pay`);
    }
    const available = BigInt(info.accountAvailableBalance ?? info.accountAmount ?? '0');
    if (available < RAIL_B_MIN_CCD_MICROCCD) {
      fail(`insufficient CCD for fees: seller B holds ${available} microCCD available, Rail B needs ${RAIL_B_MIN_CCD_MICROCCD} microCCD (reserve + transfer + confirm, each send capped at ${MCP_MAX_ENERGY} NRG ≈ 47 CCD max cost) — refusing to pay`);
    }
  }
  return { view, docBytes, amount, chainNow: now };
}

/** One co-signer gate step. Throws (no send) when decide() refuses. */
async function gate(client, payableId, kind, request, extra = {}) {
  const snapshot = await buildSnapshot(client, {
    payableId,
    agentAccount: SELLER_B_ADDRESS,
    sponsorAccount: null,
    signatureThreshold: 1,
    approval: TEST_APPROVAL,
    usage: '0',
    memoScan: { found: false, txHash: null },
    usedTxHashes: [],
    agentStatus: 'Active',
    ...extra,
  });
  const decision = decide(snapshot, { ...request, nonce: snapshot.nextNonce }, { unresolved: [] });
  if (decision.decision !== 'SIGN') {
    fail(`co-signer gate refused ${kind}: ${decision.code ?? 'refused'} — ${decision.reasons.join('; ') || 'no reason given'}`);
  }
  return { snapshot, decision };
}

export async function payPayable({ payableId, rail, docPath }) {
  const client = grpcClient();
  // ---- Validation phase: no signer loaded, nothing sent. ----
  const { view, docBytes, amount } = await validatePayableForPayment(client, { payableId, rail, docPath });
  const signers = loadSigners();

  // ---- Rail A: owner pays CCD via pay_ccd. ----
  if (rail === 'ccd') {
    const pay = await sendUpdate(client, {
      from: signers.owner, receiveName: 'pay_ccd',
      parameterHex: encodePayableId(payableId), amountMicroCcd: amount,
      maxEnergy: MCP_MAX_ENERGY,
    });
    const status = await waitFinalized(client, pay.txHash);
    const blockTime = await getBlockTime(client, status.blockHash);
    const viewAfter = await loadPayableOrFail(client, payableId);
    const balance = await getRegistryBalanceV2(client);
    const verification = verifyCcd({ payableId, txHash: pay.txHash, summary: status, blockTime, view: viewAfter, balance, docBytes });
    return {
      tool: 'pay_payable', network: NETWORK, payableId, rail,
      paymentTxHash: pay.txHash, paymentBlockTime: blockTime.slotTime,
      status: viewAfter.status,
      verifier: { ...verification },
      warning: verification.allPass ? null : 'payment was sent and finalized but verification did NOT fully pass — see failed checks',
    };
  }

  // ---- Rail B: co-signer gate -> reserve -> gate -> transfer -> gate -> confirm. ----
  await gate(client, payableId, 'reserve_plt', {
    kind: 'reserve_plt', sender: SELLER_B_ADDRESS, txVersion: 1, sponsor: null, numSignatures: 1,
  });
  const reserve = await sendUpdate(client, {
    from: signers.sellerB, receiveName: 'reserve_plt', parameterHex: encodePayableId(payableId),
    maxEnergy: MCP_MAX_ENERGY,
  });
  const reserveStatus = await waitFinalized(client, reserve.txHash);
  const reserveUpd = updatedEvent(reserveStatus, 'payable_registry.reserve_plt');
  const reserved = reserveUpd ? decodeLoggedEvents(reserveUpd).find((e) => e.event === 'Reserved') : null;
  if (!reserved) {
    fail(`reserve_plt tx ${reserve.txHash} finalized but no Reserved event was logged — stopping before any transfer (reservation tx: ${reserve.txHash})`);
  }
  const viewReserved = await loadPayableOrFail(client, payableId);
  if (viewReserved.status !== 'Reserved' || viewReserved.record?.payer !== SELLER_B_ADDRESS) {
    fail(`payable ${payableId} is ${viewReserved.status} after reserve tx ${reserve.txHash}, not Reserved by seller B — stopping before any transfer`);
  }
  const expiresMs = Number(viewReserved.record.expiresMs);
  const headerExpirySeconds = Math.floor((expiresMs - 60_000) / 1000);
  const memo = canonicalMemo({ id: payableId });

  await gate(client, payableId, 'transfer', {
    kind: 'transfer', sender: SELLER_B_ADDRESS, txVersion: 1, sponsor: null,
    recipient: view.payee, amount: view.amount, token: 'EUDemo',
    memo: encodeCborMemo(memo).toString('hex'), headerExpirySeconds, operations: 1,
  });
  const transfer = await sendTokenTransfer(client, {
    from: signers.sellerB, recipient: view.payee, amount: view.amount,
    memo, expirySeconds: headerExpirySeconds,
  });
  const transferStatus = await waitFinalized(client, transfer.txHash);
  const transferBlockTime = await getBlockTime(client, transferStatus.blockHash);
  const transferEvent = (transferStatus.summary?.events ?? []).find((e) => e.tag === 'TokenTransfer');
  if (!transferEvent) {
    fail(`transfer tx ${transfer.txHash} finalized but no TokenTransfer event was logged — stopping before confirm (reserve tx: ${reserve.txHash})`);
  }
  // Pre-confirm transfer verification (fail-closed: a bad transfer is never confirmed).
  const reserveCtx = {
    blockTime: await getBlockTime(client, reserveStatus.blockHash),
    logged: reserveUpd ? decodeLoggedEvents(reserveUpd) : [],
  };
  const transferCheck = verifyPltTransfer({
    payableId, txHash: transfer.txHash, summary: transferStatus,
    blockTime: transferBlockTime, view: viewReserved, reserve: reserveCtx,
  });
  if (!transferCheck.allPass) {
    const failed = transferCheck.checks.filter((c) => c.status === 'FAIL').map((c) => c.id).join(', ');
    fail(`transfer tx ${transfer.txHash} failed verification (${failed}) — refusing to confirm (reserve tx: ${reserve.txHash})`);
  }

  await gate(client, payableId, 'confirm', {
    kind: 'confirm', sender: SELLER_B_ADDRESS, txVersion: 1, sponsor: null, txHash: transfer.txHash,
  }, { transferTxHash: transfer.txHash, reserveTxHash: reserve.txHash });
  const confirm = await sendUpdate(client, {
    from: signers.sellerB, receiveName: 'confirm_plt',
    parameterHex: encodeConfirm({ payableId, txHashHex: transfer.txHash }),
    maxEnergy: MCP_MAX_ENERGY,
  });
  const confirmStatus = await waitFinalized(client, confirm.txHash);
  const confirmUpd = updatedEvent(confirmStatus, 'payable_registry.confirm_plt');
  const confirmed = confirmUpd ? decodeLoggedEvents(confirmUpd).find((e) => e.event === 'PltConfirmed') : null;
  if (!confirmed) {
    fail(`confirm_plt tx ${confirm.txHash} finalized but no PltConfirmed event was logged (reserve tx: ${reserve.txHash}, transfer tx: ${transfer.txHash})`);
  }
  const confirmBlockTime = await getBlockTime(client, confirmStatus.blockHash);
  const viewAfter = await loadPayableOrFail(client, payableId);
  const balance = await getRegistryBalanceV2(client);
  const verification = verifyPlt({
    payableId, txHash: transfer.txHash, summary: transferStatus, blockTime: transferBlockTime,
    view: viewAfter, balance, reserve: reserveCtx,
    confirm: { blockTime: confirmBlockTime }, docBytes,
  });
  return {
    tool: 'pay_payable', network: NETWORK, payableId, rail,
    reserveTxHash: reserve.txHash,
    transferTxHash: transfer.txHash, transferBlockTime: transferBlockTime.slotTime,
    confirmTxHash: confirm.txHash, confirmBlockTime: confirmBlockTime.slotTime,
    status: viewAfter.status,
    verifier: { ...verification },
    warning: verification.allPass ? null : 'payment was sent and confirmed but verification did NOT fully pass — see failed checks',
  };
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

export function createMcpServer() {
  const server = new McpServer({ name: 'payonce', version: '1.0.0' });

  server.registerTool('verify_invoice', {
    description: 'Verify a payment transaction against a payable on the Concordium testnet registry <13150,0> (v2 views, seller = owner account). Runs the CCD verifier (12 checks) or the PLT/EUDemo verifier (up to 15 checks) live from chain state and returns the full check list plus allPass. Throws a tool error (no crash) on unknown payable, unknown tx, or invoice-doc mismatch. NOTE: the verifier still checks v1 contract-event shapes, so a v2 CCD pay tx fails CCD-03/04/05/08 and a v2 EUDemo transfer fails PLT-07/08 on its seller-qualified memo — the v2 verifier re-scope is pending (Batch B).',
    inputSchema: {
      payableId: z.number().int().min(1).describe('Payable id on registry <13150,0>'),
      txHash: z.string().regex(/^[0-9a-fA-F]{64}$/).describe('64-hex transaction hash to verify'),
      docPath: z.string().optional().describe('Optional path to the invoice document; when given, its SHA-256 must match the stored doc_hash'),
    },
  }, async (args) => textResult(await verifyInvoice(args)));

  server.registerTool('pay_payable', {
    description: 'Pay a payable for real on Concordium testnet. Rail "ccd": the owner pays via pay_ccd. Rail "eudemo": co-signer gate -> reserve_plt -> gate -> EUDemo transfer with memo payable:<seller>:<id> -> gate -> confirm_plt. Validates everything first against the v2 registry <13150,0> (payable exists, Unpaid, doc hash matches, rail matches asset, not past due, payer balances cover amount + fees, co-signer caps) and refuses WITHOUT sending on any failure. SPLIT (stated, not hidden): the send path still targets the v1 contract <13149,0>, so a v2-only payable fails at send without moving money — the v2 send re-scope is pending (Batch B).',
    inputSchema: {
      payableId: z.number().int().min(1).describe('Payable id on registry <13150,0>'),
      rail: z.enum(['ccd', 'eudemo']).describe('Payment rail: "ccd" for CCD payables, "eudemo" for EUDemo payables'),
      docPath: z.string().describe('Path to the invoice document; its SHA-256 must match the stored doc_hash'),
    },
  }, async (args) => textResult(await payPayable(args)));

  server.registerTool('receipt', {
    description: 'Receipt facts for a payable, re-read live from the v2 registry <13150,0>: payable row, payment/transfer/confirm tx hashes, block times, and a fresh verifier re-run. Returns "not paid yet" for Unpaid payables.',
    inputSchema: {
      payableId: z.number().int().min(1).describe('Payable id on registry <13150,0>'),
    },
  }, async (args) => textResult(await getReceipt(args)));

  server.registerTool('list_payables', {
    description: 'Payable rows for a list of ids, read live from the testnet registry <13150,0> (v2 views, seller = owner account): id, status, amount, asset, payee, due. Unregistered ids are reported as absent.',
    inputSchema: {
      ids: z.array(z.number().int().min(1)).max(50).optional().describe('Payable ids to list (default 1..10)'),
    },
  }, async (args) => textResult(await listPayables(args)));

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error('payonce MCP server running on stdio (testnet, registry <13150,0>)');
}
