// PayOnce API server — pay jobs (CCD + EUDemo rails, testnet only).
// The job runner drives the SAME backend modules the MCP pay_payable tool
// drives (send + decide + snapshot + verifier), adapted to v2:
//   - views/encoders/sends keyed by (seller, id), canonical memo
//     `payable:<seller>:<id>`, co-signer gates before reserve / transfer /
//     confirm, transfer verified before confirm (fail-closed).
//   - CCD rail: payer B pays via pay_ccd (amount attached).
//   - EUDemo rail: reserve_plt (B) -> EUDemo transfer (B, memo) ->
//     confirm_plt (seller/owner).
// Submission rule (P3 §7.5): the tx hash is stored on the job the moment
// sendTransaction returns, and looked up before any retry — a retry
// returns the existing job, never a blind second send. A refusal AFTER a
// send still costs a fee; the fee is recorded on the step.
// No step sends anything the co-signer gate refused, and no confirm is
// sent for a transfer that failed verification.
import { randomBytes } from 'node:crypto';
import { backend } from './backend.mjs';
import {
  grpc,
  chainNow,
  getPayable,
  getPayableOrNull,
  getRegistryBalance,
  getAccount,
  getTx,
  getBlockTime,
  waitFinalized,
  sendUpdate,
  sendTokenTransfer,
  signers,
  updatedEvent,
  canonicalMemoV2,
  SELLER,
  PAYER,
} from './chain-v2.mjs';
import { verifyBeforePay, verifyCcdV2, verifyPltV2, verifyPltTransferV2 } from './verifier-v2.mjs';
import { buildSnapshotV2 } from './snapshot-v2.mjs';
import { appendEntry, ledgerForDecide, resolveTransfer } from './ledger.mjs';
import { docForPayable, recordedPaymentTx } from './docs.mjs';
import { loadJobs, saveJob, saveReceipt, loadCounters, saveCounters, runningJobFor } from './store.mjs';
import { REGISTRY, OWNER_ADDRESS, PAYER_ADDRESS, txUrl, fmtCcd, fmtEudemo, shortHash } from './config.mjs';

export const CCD_STEPS = ['check_status', 'check_agent', 'submit', 'wait_finality', 'read_back', 'verify'];
export const EUDEMO_STEPS = ['check_wallet', 'reserve', 'co_sign_decide', 'submit_transfer', 'wait_finality', 'confirm', 'verify'];

// ---- SSE subscribers ----
const subscribers = new Map(); // jobId -> Set<res>
export function subscribeJob(jobId, res) {
  if (!subscribers.has(jobId)) subscribers.set(jobId, new Set());
  subscribers.get(jobId).add(res);
}
export function unsubscribeJob(jobId, res) {
  subscribers.get(jobId)?.delete(res);
}
function emit(jobId, data) {
  for (const res of subscribers.get(jobId) ?? []) {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  }
}
async function emitStep(job, step) {
  emit(job.job_id, { type: 'step', step });
  await saveJob(job);
}

// ---- job creation ----
export function newJob(payableId, rail) {
  const steps = (rail === 'ccd' ? CCD_STEPS : EUDEMO_STEPS).map((step) => ({
    step, status: 'pending', detail: '', txHash: null, explorerUrl: null,
  }));
  return {
    job_id: `job_${payableId}_${rail}_${randomBytes(4).toString('hex')}`,
    payable_id: payableId,
    rail,
    state: 'running',
    steps,
    outcome: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
}

export async function createOrReturnJob(payableId, rail) {
  const jobs = await loadJobs();
  const running = runningJobFor(jobs, payableId, rail);
  if (running) return { job: running, created: false };
  const job = newJob(payableId, rail);
  await saveJob(job);
  return { job, created: true };
}

function stepOf(job, name) {
  return job.steps.find((s) => s.step === name);
}
async function setStep(job, name, status, detail, extra = {}) {
  const s = stepOf(job, name);
  Object.assign(s, { status, detail, ...extra });
  await emitStep(job, s);
  return s;
}
async function finishJob(job, state, outcome) {
  job.state = state;
  job.outcome = outcome;
  job.finished_at = new Date().toISOString();
  await saveJob(job);
  // One-time-use consent: a successful payment consumes the approved
  // consent for this payable (W-01: one-time use). A refused/failed job
  // leaves the consent approved until its 5-minute window expires.
  if (state === 'succeeded' && outcome === 'paid') {
    try {
      const { markConsentUsed } = await import('./consent.mjs');
      await markConsentUsed(job.payable_id);
    } catch { /* consent marking never fails the job */ }
  }
  emit(job.job_id, { type: 'done', outcome, receipt_url: `/api/receipts/${job.payable_id}` });
}

export function feeOf(status) {
  const cost = status?.summary?.cost;
  return cost != null ? (Number(cost) / 1e6).toFixed(6) : null;
}
export function rejectOf(status) {
  try {
    const sj = JSON.stringify(status, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const s = JSON.parse(sj);
    const rr = s.outcome?.summary?.rejectReason;
    if (rr) return rr;
    const m = sj.match(/"rejectReason":\s*(-?\d+)/);
    if (m) return { rejectReason: Number(m[1]) };
  } catch { /* no reject */ }
  return null;
}

const REJECT_NAMES = {
  '-1': 'Unauthorized', '-2': 'Duplicate', '-3': 'NotFound', '-4': 'WrongAsset',
  '-5': 'WrongStatus', '-6': 'WrongAmount', '-7': 'PastDue', '-8': 'AgentNotFound',
  '-9': 'AgentRevoked', '-10': 'AgentOwnerMismatch', '-11': 'RegistryCallFailed',
  '-12': 'TxReused', '-13': 'NotExpired', '-14': 'Invalid', '-15': 'TransferFailed',
  '-16': 'NotUnpaid', '-17': 'NotPayer', '-18': 'Invariant', '-19': 'NotApprovedVendor',
  '-20': 'LegalRefMismatch', '-21': 'NotExpectedPayer', '-22': 'ExpectedPayerRequired',
  '-23': 'CapExceeded', '-24': 'ConfirmAfterWindow', '-25': 'Voided',
  '-26': 'VoidWhileReserved', '-27': 'SelfAction',
};
export function rejectInfo(code) {
  const n = Number(code);
  return {
    code: n,
    name: REJECT_NAMES[String(n)] ?? `Reject${n}`,
    plain: `The chain refused the transaction (${REJECT_NAMES[String(n)] ?? `code ${n}`}). No money moved; the testnet fee still applied.`,
  };
}

async function payerBalances(c, view) {
  const { chain } = await backend();
  const info = await getAccount(c, PAYER_ADDRESS);
  const available = BigInt(info.accountAvailableBalance ?? info.accountAmount ?? '0');
  return {
    ccdAvailableMicro: available.toString(),
    eudemoBase: chain.tokenBalance(info, 'EUDemo'),
  };
}

async function recordVerifierRun(result) {
  const c = await loadCounters();
  c.verifierRuns += 1;
  if (result.allPass) c.verifierPassed += 1; else c.verifierFailed += 1;
  c.lastVerifierRunAt = new Date().toISOString();
  await saveCounters(c);
}

function buildReceipt(job, view, txs, verifier, paymentTxSource) {
  const amountDisplay = view.asset === 'CCD'
    ? `${(Number(view.amount) / 1e6).toFixed(6)} CCD`
    : `${(Number(view.amount) / 1e6).toFixed(2)} EUDemo`;
  return {
    payable_id: job.payable_id,
    amount_display: amountDisplay,
    payee: view.payee,
    payer_label: 'Demo payer account (lab)',
    txs: txs.map(([label, hash]) => ({ label, tx_hash: hash, explorer_url: txUrl(hash) })),
    verifier: verifier ? { passed: verifier.passed, total: verifier.total, checked_at: new Date().toISOString() } : null,
    payment_tx_source: paymentTxSource,
  };
}

async function storeReceipt(receipt) {
  await saveReceipt(receipt);
}

// ---- pre-flight: the 9 before-pay checks, split across the first steps ----
async function preflight(c, job, view, docBytes) {
  const now = await chainNow(c);
  const balances = await payerBalances(c, view);
  const result = await verifyBeforePay(c, {
    view, docBytes, chainTimeMs: now.slotMs, payerBalances: balances,
  });
  return { result, now, balances };
}

// ---- CCD rail ----
async function runCcd(job) {
  const c = await grpc();
  const { v2enc, decideMod } = await backend();
  const decide = decideMod.decide;
  const sig = await signers();
  const docBytes = await docForPayable(job.payable_id);
  try {
    await setStep(job, 'check_status', 'running', 'Reading the payable from the test registry…');
    let view = await getPayableOrNull(c, SELLER, job.payable_id);
    if (!view) {
      await setStep(job, 'check_status', 'refused', `No payable ${job.payable_id} is on the test registry <${REGISTRY.index},${REGISTRY.subindex}>.`, { layer: 'chain' });
      return await finishJob(job, 'refused', 'refused');
    }
    const { result } = await preflight(c, job, view, docBytes);
    const byId = Object.fromEntries(result.checks.map((ch) => [ch.id, ch]));
    if (view.status === 'Paid') {
      await setStep(job, 'check_status', 'refused', `Payable ${job.payable_id} is already Paid by ${view.record?.payer?.slice(0, 8)}… at ${view.record?.paidAt ?? '—'}.`, { layer: 'chain' });
      return await finishJob(job, 'refused', 'refused');
    }
    if (result.verdict !== 'ready') {
      const bad = result.checks.find((ch) => ch.status === 'fail');
      await setStep(job, 'check_status', 'refused', `Check failed (${bad?.id ?? result.blockedReason}): ${bad?.detail ?? 'not ready to pay'}.`, { layer: 'chain' });
      return await finishJob(job, 'refused', 'refused');
    }
    await setStep(job, 'check_status', 'ok', `Unpaid, due ${view.due}, doc ${byId.doc.status === 'ok' ? 'matches' : 'not supplied'}.`, { layer: 'chain' });
    await setStep(job, 'check_agent', 'running', 'Checking the seller agent and the payer balance…');
    await setStep(job, 'check_agent', 'ok', `Agent token ${view.agentToken} Active on <12802,0>; payer balance covers the payment.`, { layer: 'chain' });

    await setStep(job, 'submit', 'running', `Sending pay_ccd for ${fmtCcd(view.amount)} from the demo payer…`);
    const pay = await sendUpdate(c, {
      from: sig.sellerB, receiveName: 'pay_ccd',
      parameterHex: v2enc.encodeV2PayableKey({ seller: SELLER, id: job.payable_id }),
      amountMicroCcd: BigInt(view.amount), maxEnergy: 6000n,
    });
    stepOf(job, 'submit').txHash = pay.txHash;
    stepOf(job, 'submit').explorerUrl = txUrl(pay.txHash);
    await setStep(job, 'submit', 'ok', `pay_ccd sent: ${shortHash(pay.txHash)}`, { layer: 'chain' });

    await setStep(job, 'wait_finality', 'running', 'Waiting for the testnet to finalize the payment…');
    const status = await waitFinalized(c, pay.txHash);
    const fee = feeOf(status);
    const rr = rejectOf(status);
    if (rr) {
      const info = rejectInfo(rr.rejectReason);
      await setStep(job, 'wait_finality', 'refused', `The chain refused the payment (${info.name}). Fee: ${fee ?? '—'} testnet CCD.`, { layer: 'chain', reject: info });
      const counters = await loadCounters();
      counters.liveRefusals.push({ txHash: pay.txHash, code: info.code, at: new Date().toISOString() });
      await saveCounters(counters);
      return await finishJob(job, 'refused', 'refused');
    }
    await setStep(job, 'wait_finality', 'ok', `Finalized. Fee: ${fee ?? '—'} testnet CCD.`, { layer: 'chain' });

    await setStep(job, 'read_back', 'running', 'Reading the payable back from the registry…');
    view = await getPayable(c, SELLER, job.payable_id);
    const balance = await getRegistryBalance(c);
    if (view.status !== 'Paid') {
      await setStep(job, 'read_back', 'failed', `Payable is ${view.status} after a finalized pay_ccd — not Paid.`, { layer: 'chain' });
      return await finishJob(job, 'failed', 'failed');
    }
    await setStep(job, 'read_back', 'ok', `Status Paid by ${view.record?.payer?.slice(0, 8)}…; registry balance ${balance} microCCD.`, { layer: 'chain' });

    await setStep(job, 'verify', 'running', 'Running the verifier on the payment transaction…');
    const blockTime = await getBlockTime(c, status.blockHash);
    const verification = await verifyCcdV2(c, {
      payableId: job.payable_id, txHash: pay.txHash, summary: status, blockTime, view, balance, docBytes,
    });
    await recordVerifierRun(verification);
    const receipt = buildReceipt(job, view, [['Payment', pay.txHash]], verification, 'server_store');
    await storeReceipt(receipt);
    if (!verification.allPass) {
      const failed = verification.checks.filter((ch) => ch.status === 'fail').map((ch) => ch.id).join(', ');
      await setStep(job, 'verify', 'failed', `Payment is Paid on chain, but verification failed (${failed}). Receipt stored; see /api/receipts/${job.payable_id}.`, { layer: 'chain' });
      return await finishJob(job, 'failed', 'failed');
    }
    await setStep(job, 'verify', 'ok', `Verifier: ${verification.passed}/${verification.total} checks pass.`, { layer: 'chain' });
    return await finishJob(job, 'succeeded', 'paid');
  } catch (e) {
    const step = job.steps.find((s) => s.status === 'running') ?? stepOf(job, 'submit');
    await setStep(job, step.step, 'failed', `Error: ${e.message}`, { layer: 'server' });
    return await finishJob(job, 'failed', 'failed');
  }
}

// ---- EUDemo rail ----
async function runEudemo(job) {
  const c = await grpc();
  const { v2enc, v2ev, chain, decideMod } = await backend();
  const decide = decideMod.decide;
  const sig = await signers();
  const docBytes = await docForPayable(job.payable_id);
  const payableKey = `${SELLER}:${job.payable_id}`;
  try {
    await setStep(job, 'check_wallet', 'running', 'Reading the payable, the payer wallet and the vendor approval…');
    let view = await getPayableOrNull(c, SELLER, job.payable_id);
    if (!view) {
      await setStep(job, 'check_wallet', 'refused', `No payable ${job.payable_id} is on the test registry <${REGISTRY.index},${REGISTRY.subindex}>.`, { layer: 'chain' });
      return await finishJob(job, 'refused', 'refused');
    }
    if (view.asset !== 'EUDemo') {
      await setStep(job, 'check_wallet', 'refused', `Payable ${job.payable_id} is a ${view.asset} payable, not EUDemo.`, { layer: 'app' });
      return await finishJob(job, 'refused', 'refused');
    }
    const { result } = await preflight(c, job, view, docBytes);
    if (view.status === 'Paid') {
      await setStep(job, 'check_wallet', 'refused', `Payable ${job.payable_id} is already Paid.`, { layer: 'chain' });
      return await finishJob(job, 'refused', 'refused');
    }
    if (result.verdict !== 'ready') {
      const bad = result.checks.find((ch) => ch.status === 'fail');
      await setStep(job, 'check_wallet', 'refused', `Check failed (${bad?.id ?? result.blockedReason}): ${bad?.detail ?? 'not ready to pay'}.`, { layer: 'chain' });
      return await finishJob(job, 'refused', 'refused');
    }
    await setStep(job, 'check_wallet', 'ok', `EUDemo ${fmtEudemo(view.amount)}; payer wallet covers amount + fees; vendor approval on chain.`, { layer: 'chain' });

    // Gate 1: reserve.
    await setStep(job, 'reserve', 'running', 'Co-signer gate: deciding the reservation…');
    let snapshot = await buildSnapshotV2(c, { seller: SELLER, payableId: job.payable_id, agentAccount: PAYER_ADDRESS, sponsorAccount: null, signatureThreshold: 1 });
    let decision = decide(snapshot, { kind: 'reserve_plt', sender: PAYER_ADDRESS, txVersion: 1, sponsor: null, numSignatures: 1, nonce: snapshot.nextNonce }, await ledgerForDecide(payableKey));
    if (decision.decision !== 'SIGN') {
      await setStep(job, 'reserve', 'refused', `Co-signer refused the reservation (${decision.code}): ${decision.reasons.join('; ')}`, { layer: 'co_signer' });
      return await finishJob(job, 'refused', 'refused');
    }
    const reserve = await sendUpdate(c, {
      from: sig.sellerB, receiveName: 'reserve_plt',
      parameterHex: v2enc.encodeV2PayableKey({ seller: SELLER, id: job.payable_id }), maxEnergy: 6000n,
    });
    stepOf(job, 'reserve').txHash = reserve.txHash;
    stepOf(job, 'reserve').explorerUrl = txUrl(reserve.txHash);
    const reserveStatus = await waitFinalized(c, reserve.txHash);
    const reserveRr = rejectOf(reserveStatus);
    if (reserveRr) {
      const info = rejectInfo(reserveRr.rejectReason);
      await setStep(job, 'reserve', 'refused', `The chain refused the reservation (${info.name}). Fee: ${feeOf(reserveStatus) ?? '—'} testnet CCD.`, { layer: 'chain', reject: info });
      return await finishJob(job, 'refused', 'refused');
    }
    const reserveUpd = updatedEvent(reserveStatus, 'reserve_plt');
    const reservedEvent = reserveUpd ? v2ev.decodeLoggedEventsV2(reserveUpd).find((e) => e.event === 'Reserved') : null;
    if (!reservedEvent) {
      await setStep(job, 'reserve', 'failed', `reserve_plt finalized (${shortHash(reserve.txHash)}) but no Reserved event was logged — stopping before any transfer.`, { layer: 'chain' });
      return await finishJob(job, 'failed', 'failed');
    }
    view = await getPayable(c, SELLER, job.payable_id);
    if (view.status !== 'Reserved' || view.record?.payer !== PAYER_ADDRESS) {
      await setStep(job, 'reserve', 'failed', `Payable is ${view.status} after reserve ${shortHash(reserve.txHash)}, not Reserved by the demo payer — stopping before any transfer.`, { layer: 'chain' });
      return await finishJob(job, 'failed', 'failed');
    }
    const expiresMs = Number(view.record.expiresMs);
    await setStep(job, 'reserve', 'ok', `Reserved until ${view.record.expires} (reservation ${shortHash(reserve.txHash)}).`, { layer: 'chain' });

    // Gate 2: transfer.
    const headerExpirySeconds = Math.floor((expiresMs - 60_000) / 1000);
    const memo = canonicalMemoV2(SELLER, job.payable_id);
    await setStep(job, 'co_sign_decide', 'running', 'Co-signer gate: deciding the transfer…');
    snapshot = await buildSnapshotV2(c, { seller: SELLER, payableId: job.payable_id, agentAccount: PAYER_ADDRESS, sponsorAccount: null, signatureThreshold: 1 });
    decision = decide(snapshot, {
      kind: 'transfer', sender: PAYER_ADDRESS, txVersion: 1, sponsor: null, nonce: snapshot.nextNonce,
      recipient: view.payee, amount: view.amount, token: 'EUDemo',
      memo: chain.encodeCborMemo(memo).toString('hex'), headerExpirySeconds, operations: 1,
    }, await ledgerForDecide(payableKey));
    if (decision.decision !== 'SIGN') {
      await setStep(job, 'co_sign_decide', 'refused', `Co-signer refused the transfer (${decision.code}): ${decision.reasons.join('; ')}`, { layer: 'co_signer' });
      return await finishJob(job, 'refused', 'refused');
    }
    await setStep(job, 'co_sign_decide', 'ok', 'Co-signer approved the transfer (reserve + transfer gates: SIGN).', { layer: 'co_signer' });

    await setStep(job, 'submit_transfer', 'running', `Sending the EUDemo transfer (${fmtEudemo(view.amount)}) with memo ${memo}…`);
    const transfer = await sendTokenTransfer(c, {
      from: sig.sellerB, recipient: view.payee, amount: view.amount, memo, expirySeconds: headerExpirySeconds,
    });
    stepOf(job, 'submit_transfer').txHash = transfer.txHash;
    stepOf(job, 'submit_transfer').explorerUrl = txUrl(transfer.txHash);
    await appendEntry({
      ts: new Date().toISOString(), kind: 'transfer', payableKey, txHash: transfer.txHash,
      headerExpiry: headerExpirySeconds, reservationExpires: view.record.expiresMs, decision: 'SIGN', state: 'unresolved',
    });
    await setStep(job, 'submit_transfer', 'ok', `Transfer sent: ${shortHash(transfer.txHash)}`, { layer: 'chain' });

    await setStep(job, 'wait_finality', 'running', 'Waiting for the transfer to finalize, then verifying it…');
    const transferStatus = await waitFinalized(c, transfer.txHash);
    const transferBlockTime = await getBlockTime(c, transferStatus.blockHash);
    const transferEvent = (transferStatus.summary?.events ?? []).find((e) => e.tag === 'TokenTransfer');
    if (!transferEvent) {
      await setStep(job, 'wait_finality', 'failed', `Transfer ${shortHash(transfer.txHash)} finalized but no TokenTransfer event was logged — stopping before confirm.`, { layer: 'chain' });
      return await finishJob(job, 'failed', 'failed');
    }
    const reserveCtx = { blockTime: await getBlockTime(c, reserveStatus.blockHash), logged: reserveUpd ? v2ev.decodeLoggedEventsV2(reserveUpd) : [] };
    const transferCheck = await verifyPltTransferV2({
      payableId: job.payable_id, summary: transferStatus, blockTime: transferBlockTime, view, reserve: reserveCtx,
    });
    if (!transferCheck.allPass) {
      const failed = transferCheck.checks.filter((ch) => ch.status === 'fail').map((ch) => ch.id).join(', ');
      await setStep(job, 'wait_finality', 'failed', `Transfer failed verification (${failed}) — refusing to confirm (reserve ${shortHash(reserve.txHash)}).`, { layer: 'chain' });
      return await finishJob(job, 'failed', 'failed');
    }
    await setStep(job, 'wait_finality', 'ok', `Transfer finalized and verified (${transferCheck.passed}/${transferCheck.total} checks).`, { layer: 'chain' });

    // Gate 3: confirm. The confirm_plt entrypoint requires the RESERVING
    // PAYER as sender (-17 NotPayer otherwise): on v2 the payer (B)
    // confirms, not the seller. (v1's "confirm by seller" was the old
    // mirrored role — in v1 the seller WAS B. The v2 E2E proves the payer
    // sends it.) The gate's request sender is the agent account too.
    await setStep(job, 'confirm', 'running', 'Co-signer gate: deciding the confirm…');
    snapshot = await buildSnapshotV2(c, {
      seller: SELLER, payableId: job.payable_id, agentAccount: PAYER_ADDRESS, sponsorAccount: null,
      signatureThreshold: 1, transferTxHash: transfer.txHash, reserveTxHash: reserve.txHash,
    });
    decision = decide(snapshot, {
      kind: 'confirm', sender: PAYER_ADDRESS, txVersion: 1, sponsor: null, nonce: snapshot.nextNonce, txHash: transfer.txHash,
    }, await ledgerForDecide(payableKey));
    if (decision.decision !== 'SIGN') {
      await setStep(job, 'confirm', 'refused', `Co-signer refused the confirm (${decision.code}): ${decision.reasons.join('; ')}`, { layer: 'co_signer' });
      return await finishJob(job, 'refused', 'refused');
    }
    const confirm = await sendUpdate(c, {
      from: sig.sellerB, receiveName: 'confirm_plt',
      parameterHex: v2enc.encodeV2Confirm({ seller: SELLER, id: job.payable_id, txHashHex: transfer.txHash }), maxEnergy: 6000n,
    });
    stepOf(job, 'confirm').txHash = confirm.txHash;
    stepOf(job, 'confirm').explorerUrl = txUrl(confirm.txHash);
    const confirmStatus = await waitFinalized(c, confirm.txHash);
    const confirmRr = rejectOf(confirmStatus);
    if (confirmRr) {
      const info = rejectInfo(confirmRr.rejectReason);
      await setStep(job, 'confirm', 'refused', `The chain refused the confirm (${info.name}). Fee: ${feeOf(confirmStatus) ?? '—'} testnet CCD.`, { layer: 'chain', reject: info });
      return await finishJob(job, 'refused', 'refused');
    }
    const confirmUpd = updatedEvent(confirmStatus, 'confirm_plt');
    const confirmLogged = confirmUpd ? v2ev.decodeLoggedEventsV2(confirmUpd) : [];
    const confirmedEvent = confirmLogged.find((e) => e.event === 'PltConfirmed');    if (!confirmedEvent) {
      await setStep(job, 'confirm', 'failed', `confirm_plt finalized (${shortHash(confirm.txHash)}) but no PltConfirmed event was logged.`, { layer: 'chain' });
      return await finishJob(job, 'failed', 'failed');
    }
    await resolveTransfer(payableKey, transfer.txHash);
    view = await getPayable(c, SELLER, job.payable_id);
    const balance = await getRegistryBalance(c);
    if (view.status !== 'Paid') {
      await setStep(job, 'confirm', 'failed', `Payable is ${view.status} after a finalized confirm — not Paid.`, { layer: 'chain' });
      return await finishJob(job, 'failed', 'failed');
    }
    await setStep(job, 'confirm', 'ok', `Confirmed: ${shortHash(confirm.txHash)}. Status Paid.`, { layer: 'chain' });

    await setStep(job, 'verify', 'running', 'Running the verifier on the transfer…');
    const confirmBlockTime = await getBlockTime(c, confirmStatus.blockHash);
    const verification = await verifyPltV2(c, {
      payableId: job.payable_id, txHash: transfer.txHash, summary: transferStatus, blockTime: transferBlockTime,
      view, balance, docBytes, reserve: reserveCtx,
      registryIndex: String(REGISTRY.index), gen: 'v2',
      // G7 fix-back-4 ADV-2: the PltConfirmed event decoded above —
      // pltConfirmRow requires the event, not just the block time.
      // G7 fix-back-6 MF-1: gen 'v2' is a CALLER signal (v2 registry
      // view); see server.mjs pltEvidenceFor. G7 fix-back-7 MF-1: the
      // verifier no longer reads it — kept for shape stability.
      confirm: { blockTime: confirmBlockTime, logged: confirmLogged, gen: 'v2' },
    });
    await recordVerifierRun(verification);
    const receipt = buildReceipt(job, view, [
      ['Reservation', reserve.txHash],
      ['Transfer', transfer.txHash],
      ['Confirm', confirm.txHash],
    ], verification, 'chain');
    await storeReceipt(receipt);
    if (!verification.allPass) {
      const failed = verification.checks.filter((ch) => ch.status === 'fail').map((ch) => ch.id).join(', ');
      await setStep(job, 'verify', 'failed', `Payment is Paid on chain, but verification failed (${failed}). Receipt stored; see /api/receipts/${job.payable_id}.`, { layer: 'chain' });
      return await finishJob(job, 'failed', 'failed');
    }
    await setStep(job, 'verify', 'ok', `Verifier: ${verification.passed}/${verification.total} checks pass.`, { layer: 'chain' });
    return await finishJob(job, 'succeeded', 'paid');
  } catch (e) {
    const step = job.steps.find((s) => s.status === 'running') ?? job.steps[job.steps.length - 1];
    await setStep(job, step.step, 'failed', `Error: ${e.message}`, { layer: 'server' });
    return await finishJob(job, 'failed', 'failed');
  }
}

export async function failJob(job, message) {
  const step = job.steps.find((s) => s.status === 'running') ?? job.steps[job.steps.length - 1];
  if (step.status === 'pending' || step.status === 'running') {
    step.status = 'failed';
    step.detail = message;
    step.layer = 'server';
  }
  await finishJob(job, 'failed', 'failed');
}

/** Run a job. Setup errors (no gRPC, no wallet) fail the job instead of
 *  leaving it stuck in `running` with an unhandled rejection. */
export async function runJob(job) {
  try {
    if (job.rail === 'ccd') return await runCcd(job);
    return await runEudemo(job);
  } catch (e) {
    return await failJob(job, `Could not start the payment: ${e.message}`);
  }
}
