// PayOnce API server — receipts (P3 §7.6, §16.13).
// A receipt is rebuilt LIVE from the chain on every request: the payable
// row, the payment transaction(s), and a fresh verifier re-run. The
// payment tx hash comes from the server store (this server's jobs) or the
// recorded evidence index (payables 10/11) — never guessed:
//   - CCD: the v2 contract does NOT record the pay tx hash (F5), so the
//     source is `server_store` and the ReceiptStep shows that note.
//   - EUDemo: confirm_plt records the transfer hash on chain, so the
//     source is `chain` (the stored hash is checked against the live view).
// The receipt's verifier field is the fresh after-pay re-run (10 checks
// CCD / 14 checks EUDemo — the 12 P3 checks plus the fail-closed
// reservation + paid_at rows, G7 fix-back-3 MF-3), plus the stored-tx-hash
// receipt-binding extra (paid_at is already covered by the after-pay run,
// so it is not counted twice — see buildReceiptFor).
//
// Art. 12 record (workshops W4 §7.3–7.4; W-42): every receipt also carries
// an `art12` object — the EU AI Act Art. 12 field list (agent/model, task,
// task-giver, authoriser, decisions, payment details, errors, human
// overrides), a random nonce, a recordHash = sha256 of the canonical
// record JSON (helpers shared with backend/src/receipt/build.mjs), and a
// registerData anchor of the record hash on chain (VRA/VAA-style CBOR pair
// where it fits — here a 32-byte hash anchor; the consent flow anchors the
// full VRA/VAA pair, see api/src/consent.mjs). The record's stable core
// never changes after first build: the nonce, the core fields and the
// anchor tx are stored with the receipt and reused on every rebuild, so
// the recordHash stays verifiable; only the fresh `verifier` re-run is
// refreshed. Retention: ≥6 months, provider responsible (statement in
// the record and on the judge page). No PII goes on chain — only the hash.
import { randomBytes } from 'node:crypto';
import { Transaction, DataBlob, TransactionExpiry, AccountAddress, SequenceNumber } from '@concordium/web-sdk';
import { backend } from './backend.mjs';
import {
  grpc, getPayableOrNull, getRegistryBalance, getTx, getBlockTime, updatedEvent, signers,
  nextNonce, withNonceRetry,
  SELLER, SELLER2,
} from './chain-v2.mjs';
import { verifyCcdV2, verifyPltV2, pltReceiptExtraChecks } from './verifier-v2.mjs';
import { docForPayable, docForPayableForSeller, recordedPaymentTx, recordedPaymentTxForSeller } from './docs.mjs';
import { loadReceipts, saveReceipt, updateCounters, loadConsents, receiptKey, consentKey } from './store.mjs';
import { REGISTRY, OWNER_ADDRESS, txUrl } from './config.mjs';
import { recoverCcdPaymentTx } from './recover.mjs';

export const ART12_RETENTION =
  'Retained for at least 6 months by the provider (PayOnce lab) from the payment date, as EU AI Act Art. 12 requires for AI-system logs. The record itself holds no personal data; only its hash is anchored on chain.';
export const ART12_AGENT = {
  name: 'PayOnce demo agent',
  registry_token: 1476,
  registry: '<12802,0>',
  owner: OWNER_ADDRESS,
  badge: 'JyP9XawpXHMjTN5ocrA5a',
};
export const ART12_AGENT_SELLER2 = {
  name: 'PayOnce demo agent (second seller)',
  registry_token: 1506,
  registry: '<12802,0>',
  owner: SELLER2,
  badge: 'JyP9Y9nGU4KaM7DBDXRgm',
};
export const ART12_MODEL =
  'No language model — deterministic decision code (co-signer decide() + mandate contract on <13150,0>). No LLM is anywhere in this payment flow.';

/** The stable Art. 12 core for a paid payable (no volatile fields). */
export function buildArt12Core({ payableId, view, txs, verifier, consent }) {
  const txHashes = txs.map(([, hash]) => hash);
  return {
    agent: view.seller === SELLER2 ? ART12_AGENT_SELLER2 : ART12_AGENT,
    model: ART12_MODEL,
    task: `Verify & Pay payable ${payableId} (${view.asset === 'CCD' ? `${(Number(view.amount) / 1e6).toFixed(6)} CCD` : `${(Number(view.amount) / 1e6).toFixed(2)} EUDemo`})`,
    task_giver: `Demo payer account (lab) ${view.record?.payer ?? 'unknown'}`,
    authoriser: 'Owner/co-signer (2-of-3 agent wallet): seller B approves the seller, the co-signer decision-gates every sign, the owner holds the recovery key',
    decisions: {
      verifier: verifier ? `after-pay verifier ${verifier.passed}/${verifier.total} (checked ${verifier.checked_at})` : 'verifier did not run on this build',
      mandate: 'per-payable + period caps, vendor allow-list, reservation expiry — enforced by the mandate contract <13150,0> and the co-signer decide() gate',
      consent: consent?.status === 'approved'
        ? `owner consent approved (VRA ${consent.vraTx}, VAA ${consent.vaaTx})`
        : consent ? `consent ${consent.status} (VRA ${consent.vraTx ?? 'none'})` : 'no consent request on file for this payable',
    },
    payment: {
      lock: 'mandate contract <13150,0> (payable_registry_v2) — no funds held by the badge; spending is gated by the mandate, not by the badge',
      amount: view.amount,
      asset: view.asset,
      recipients: [view.payee],
      payer: view.record?.payer ?? null,
      tx_hashes: txHashes,
    },
    errors: [],
    human_overrides: consent?.status === 'approved'
      ? [`owner consent approval for payable ${payableId} (VRA ${consent.vraTx}, VAA ${consent.vaaTx})`]
      : [],
    consent: consent ? { status: consent.status, vra_tx: consent.vraTx, vaa_tx: consent.vaaTx, consent_sha256: consent.consentSha256 } : null,
    retention: ART12_RETENTION,
    registry: `<${REGISTRY.index},${REGISTRY.subindex}>`,
    network: 'testnet',
  };
}

/**
 * A read-back result is a DEAD anchor only when the node has no record of
 * the tx at all ("transaction not found"). Any other non-finalized state
 * (received / committed, or a transient gRPC error) means the tx may still
 * land — the stored hash is kept and re-checked, never cleared.
 */
export function isDeadAnchor(check) {
  const text = `${check?.status ?? ''} ${check?.reason ?? ''}`;
  return /transaction not found/i.test(text);
}

/**
 * FIX-BACK-3 (M1): wait until a just-sent anchor tx is finalized on chain.
 * A send that the node accepted into the mempool can still be dropped
 * under owner-nonce contention (live-proven: receipt 1001's anchor
 * `a3d92c48…` — send returned a hash, the node never finalized it, and
 * three later gRPC reads all said "transaction not found").
 * A "not found" straight after send may also be load-balancer
 * propagation lag, so it only counts as dead after 3 consecutive
 * not-found polls (~6 s); a tx the node knows about (received /
 * committed) is waited on instead. Returns { ok:true } once finalized,
 * else { ok:false, reason } — the caller must NOT store the hash then.
 */
export async function waitForAnchorFinalized(txHash, attempts = 20, intervalMs = 2000) {
  let notFoundStreak = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const check = await verifyRecordAnchor(txHash);
    if (check.ok) return { ok: true, status: check.status };
    if (isDeadAnchor(check)) {
      notFoundStreak += 1;
      if (notFoundStreak >= 3) {
        return { ok: false, reason: `anchor tx ${txHash} not found after send — the node never finalized it (mempool drop); not stored, retry on next read` };
      }
    } else {
      // Known to the node but not finalized yet (received / committed) —
      // or a transient read error: wait, do not declare it dead.
      notFoundStreak = 0;
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, reason: `anchor tx ${txHash} not finalized within ${Math.round((attempts * intervalMs) / 1000)}s — not stored, retry on next read` };
}

/**
 * Anchor a 32-byte record hash via registerData (owner-signed, testnet).
 * Returns { txHash, explorerUrl } or { error } when no signer is available
 * on this host (fail-soft: the receipt is still served, anchorStatus says
 * so — never a fake anchor).
 *
 * FIX-BACK-2 (M4): the send runs under withNonceRetry (same treatment as
 * sendTokenTransfer) — a stale owner nonce under concurrency used to
 * reject the anchor with "Duplicate nonce" and permanently lose it, since
 * the rebuild path never re-attempted. A duplicate-nonce rejection happens
 * BEFORE acceptance, so rebuilding with a fresh nonce cannot double-send;
 * bounded (6 attempts, 4 s apart, see chain-v2.mjs).
 *
 * FIX-BACK-3 (M1): the returned hash is only reported after finality is
 * confirmed (waitForAnchorFinalized). A send whose tx the node never
 * finalizes returns { error } instead of a hash, so no dead hash is ever
 * stored — the next read retries the same record hash. A second, later
 * anchor of the SAME record hash is harmless: both txs carry identical
 * data, so either one verifies the record.
 */
export async function anchorRecordHash(recordHashHex) {
  try {
    const out = await withNonceRetry(async () => {
      const c = await grpc();
      const sig = await signers();
      const { owner } = sig;
      // Dual-copy boundary (see buyer-agent.mjs): nonce via the
      // string-address helper, never c.getAccountInfo with this file's
      // AccountAddress.
      const nonce = await nextNonce(c, owner.address);
      const data = new DataBlob(Uint8Array.from(Buffer.from(recordHashHex, 'hex')).buffer);
      const tx = Transaction.registerData({ data }).addMetadata({
        sender: AccountAddress.fromBase58(owner.address),
        nonce: SequenceNumber.create(nonce),
        expiry: TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
      });
      const finalized = await Transaction.signAndFinalize(tx.build(), owner.signer);
      const hash = await c.sendTransaction(finalized);
      const txHash = (typeof hash === 'string' ? hash : Buffer.from(hash.buffer ?? hash).toString('hex')).toLowerCase();
      return { txHash, explorerUrl: txUrl(txHash) };
    });
    const confirmed = await waitForAnchorFinalized(out.txHash);
    if (!confirmed.ok) return { error: confirmed.reason };
    return out;
  } catch (e) {
    return { error: String(e?.message ?? e).slice(0, 300) };
  }
}

/** Read-back check: is the anchor tx finalized on chain? */
export async function verifyRecordAnchor(txHash) {
  if (!txHash) return { ok: false, reason: 'no_anchor_tx' };
  try {
    const c = await grpc();
    const status = await getTx(c, txHash);
    return { ok: status.status === 'finalized', status: status.status, txHash };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Payment transactions for a paid payable, from the store then evidence. */
async function paymentTxsStored(payableId, view) {
  const receipts = await loadReceipts();
  // The receipt store is keyed by (seller, payable id); seller 1's matrix
  // payable 1 shares the id with seller 2's payable 1. A stored receipt
  // only counts when its key matches this view's seller EXACTLY — there
  // is no legacy fallback: a seller-less (pre-patch) stored row is never
  // served to either seller (fix-back §4.2; the planted-legacy regression
  // test in test/live.test.mjs proves it).
  const stored = receipts[receiptKey(view.seller, payableId)];
  if (stored?.txs?.length) {
    return {
      txs: stored.txs.map((t) => [t.label, t.tx_hash]),
      source: stored.payment_tx_source,
    };
  }
  if (view.seller === SELLER2) {
    const rec2 = recordedPaymentTxForSeller(view.seller, payableId);
    if (rec2) {
      // Mirror the seller-1 EUDemo branch below: the transfer leg is
      // labelled 'Transfer' (not 'Payment') and the reserve/confirm legs
      // ride along — the EUDemo verifier needs all three, and a 'Payment'
      // label here used to make the verifier never run (fix-back §4.1).
      if (view.asset === 'EUDemo' && rec2.transferTx) {
        const txs = [];
        if (rec2.reserveTx) txs.push(['Reservation', rec2.reserveTx]);
        txs.push(['Transfer', rec2.transferTx]);
        if (rec2.confirmTx) txs.push(['Confirm', rec2.confirmTx]);
        return { txs, source: 'chain' };
      }
      if (rec2.payTx) return { txs: [['Payment', rec2.payTx]], source: 'server_store' };
    }
    // Seller-key rule: seller 1's evidence index (recordedPaymentTx) is
    // keyed by bare id. A seller-2 payable with no seller-2 evidence must
    // never be answered with seller 1's transactions for the same id.
    return { txs: [], source: view.asset === 'CCD' ? 'server_store' : 'chain' };
  }
  const rec = recordedPaymentTx(payableId);
  // PLT fallback: confirm_plt records the transfer hash on chain, so a
  // Paid EUDemo payable always names its transfer transaction — even one
  // paid outside this server (or recovered manually, as #1001 was).
  if (view.asset === 'EUDemo' && view.record?.txHash) {
    const txs = [['Transfer', view.record.txHash]];
    if (rec?.reserveTx) txs.unshift(['Reservation', rec.reserveTx]);
    if (rec?.confirmTx) txs.push(['Confirm', rec.confirmTx]);
    return { txs, source: 'chain' };
  }
  if (rec) {
    if (view.asset === 'CCD' && rec.payTx) {
      return { txs: [['Payment', rec.payTx]], source: 'server_store' };
    }
    if (view.asset === 'EUDemo' && rec.transferTx) {
      const txs = [];
      if (rec.reserveTx) txs.push(['Reservation', rec.reserveTx]);
      txs.push(['Transfer', rec.transferTx]);
      if (rec.confirmTx) txs.push(['Confirm', rec.confirmTx]);
      return { txs, source: 'chain' };
    }
  }
  return { txs: [], source: view.asset === 'CCD' ? 'server_store' : 'chain' };
}

/** Stored / recorded legs first; for a Paid payable the server never saw (paid outside the API),
 *  the chain itself names the payment: the EUDemo view stores the transfer hash, and a CCD pay
 *  tx is found from the Paid event in the block at paidAt. Never invents a hash. */
export async function paymentTxsFor(payableId, view) {
  const found = await paymentTxsStored(payableId, view);
  if (found.txs.length || view.status !== 'Paid') return found;
  try {
    if (view.asset === 'EUDemo' && view.record?.txHash) return { txs: [['Transfer', view.record.txHash]], source: 'chain' };
    if (view.asset === 'CCD') {
      const tx = await recoverCcdPaymentTx(payableId, view.seller);
      if (tx) return { txs: [['Payment', tx]], source: 'chain' };
    }
  } catch { /* fall through: no receipt rather than a guessed one */ }
  return found;
}

/** Build (and store) the receipt for a paid payable. Returns null when
 *  the payable is not Paid, or when the payment tx hash is unknown. */
export async function buildReceiptFor(payableId, seller = SELLER) {
  const c = await grpc();
  const view = await getPayableOrNull(c, seller, payableId);
  if (!view || view.status !== 'Paid') return null;
  const { txs, source } = await paymentTxsFor(payableId, view);
  if (txs.length === 0) return null;
  const docBytes = await docForPayableForSeller(seller, payableId);
  const balance = await getRegistryBalance(c);

  let verifier = null;
  try {
    if (view.asset === 'CCD') {
      const payHash = txs.find(([l]) => l === 'Payment')?.[1] ?? txs[0][1];
      const summary = await getTx(c, payHash);
      const blockTime = await getBlockTime(c, summary.blockHash);
      const result = await verifyCcdV2(c, {
        payableId, txHash: payHash, summary, blockTime, view, balance, docBytes,
      });
      verifier = { passed: result.passed, total: result.total, checked_at: new Date().toISOString() };
    } else {
      // Defense in depth (fix-back §4.1): the transfer leg is labelled
      // 'Transfer', but accept a 'Payment'-labelled leg as the transfer
      // hash when no 'Transfer' leg exists — a mislabelled evidence
      // entry must not silently skip the verifier again.
      const transferHash = txs.find(([l]) => l === 'Transfer')?.[1] ?? txs.find(([l]) => l === 'Payment')?.[1];
      const confirmHash = txs.find(([l]) => l === 'Confirm')?.[1];
      const reserveHash = txs.find(([l]) => l === 'Reservation')?.[1];
      if (transferHash) {
        const summary = await getTx(c, transferHash);
        const blockTime = await getBlockTime(c, summary.blockHash);
        let confirm = null;
        if (confirmHash) {
          const { v2ev } = await backend();
          const cs = await getTx(c, confirmHash);
          // G7 fix-back-4 ADV-2: the confirm carries its decoded
          // PltConfirmed event — pltConfirmRow requires the event, not
          // just the block time.
          // G7 fix-back-6 MF-1: gen 'v2' is a CALLER signal (v2 registry
          // view); see server.mjs pltEvidenceFor. G7 fix-back-7 MF-1:
          // the verifier no longer reads it — kept for shape stability.
          const cupd = updatedEvent(cs, 'confirm_plt');
          confirm = { blockTime: await getBlockTime(c, cs.blockHash), logged: cupd ? v2ev.decodeLoggedEventsV2(cupd) : [], gen: 'v2' };
        }
        // G7 fix-back-3 MF-3: the receipt re-run supplies the real
        // reserve too (it is in the stored legs) — without it the
        // fail-closed reservation row would fail every receipt.
        let reserve = null;
        if (reserveHash) {
          const { v2ev } = await backend();
          const rs = await getTx(c, reserveHash);
          const rbt = await getBlockTime(c, rs.blockHash);
          const upd = updatedEvent(rs, 'reserve_plt');
          reserve = { blockTime: rbt, logged: upd ? v2ev.decodeLoggedEventsV2(upd) : [] };
        }
        const result = await verifyPltV2(c, {
          payableId, txHash: transferHash, summary, blockTime, view, balance, docBytes, confirm, reserve,
          registryIndex: String(REGISTRY.index), gen: 'v2',
        });
        // verifyPltV2 now covers paid_at_is_confirm_time itself, so the
        // receipt extras contribute only stored_tx_hash — counting
        // paid_at twice would inflate the receipt verifier total.
        const extras = pltReceiptExtraChecks(view, transferHash, confirm, { registryIndex: String(REGISTRY.index), gen: 'v2', reserve })
          .filter((ch) => ch.id === 'stored_tx_hash');
        const extraPassed = extras.filter((ch) => ch.status === 'ok').length;
        verifier = {
          passed: result.passed + extraPassed,
          total: result.total + extras.length,
          checked_at: new Date().toISOString(),
        };
      }
    }
    await updateCounters((counters) => {
      counters.verifierRuns += 1;
      if (verifier && verifier.passed === verifier.total) counters.verifierPassed += 1;
      else counters.verifierFailed += 1;
      counters.lastVerifierRunAt = new Date().toISOString();
    });
  } catch (e) {
    // The verifier failing to run is reported as a null verifier, never as
    // a fake pass — the receipt still names its transactions.
    verifier = null;
  }

  const amountDisplay = view.asset === 'CCD'
    ? `${(Number(view.amount) / 1e6).toFixed(6)} CCD`
    : `${(Number(view.amount) / 1e6).toFixed(2)} EUDemo`;
  const receipt = {
    payable_id: payableId,
    seller: view.seller,
    amount_display: amountDisplay,
    payee: view.payee,
    payer_label: 'Demo payer account (lab)',
    txs: txs.map(([label, hash]) => ({ label, tx_hash: hash, explorer_url: txUrl(hash) })),
    verifier,
    payment_tx_source: source,
  };

  // ---- Art. 12 record (W-42) ----
  // The stable core + nonce + recordHash + anchor live in the stored
  // receipt and are reused on every rebuild, so the hash stays verifiable.
  // FIX-BACK-2 (M4): a stored record whose first-build anchor FAILED
  // (anchor_tx null, e.g. "Duplicate nonce") is re-anchored on rebuild —
  // a transient nonce collision must not permanently lose a paid
  // receipt's Art. 12 anchor. FIX-BACK-3 (M1): the same applies to a
  // stored anchor whose tx the node never finalized ("transaction not
  // found") — a dead non-null anchor is cleared and re-anchored, never
  // re-reported forever. The re-attempt sends exactly one
  // registerData tx for the SAME record hash (the hash never changes),
  // so it cannot create a second, different anchor. A receipt that
  // predates Art. 12 anchoring with no record hash at all still gets its
  // anchor only on first build (below); a GET never mints a new record.
  // The stored Art. 12 core is looked up by the composite (seller, id)
  // key and only reused when the stored receipt belongs to THIS seller
  // (fix-back §4.2/§4.3): the old bare-id lookup let one seller's receipt
  // inherit the other's Art. 12 core (agent token, badge, anchor). The
  // consent lookup is keyed the same way.
  const stored = (await loadReceipts())[receiptKey(view.seller, payableId)];
  const consents = await loadConsents();
  const consent = consents[consentKey(view.seller, payableId)] ?? null;
  const { receiptBuild } = await backend();
  const ART12_CORE_KEYS = ['agent', 'model', 'task', 'task_giver', 'authoriser', 'decisions', 'payment', 'errors', 'human_overrides', 'consent', 'retention', 'registry', 'network'];
  if (stored?.art12?.record_hash && stored.art12.nonce) {
    // Integrity: recompute the hash from the stored core + nonce. A
    // mismatch means the stored record was tampered with — rebuild it
    // fresh below instead of serving a hash that does not match.
    const coreFromStored = Object.fromEntries(ART12_CORE_KEYS.map((k) => [k, stored.art12[k]]));
    const recomputed = receiptBuild.computeRecordHash({ ...coreFromStored, nonce: stored.art12.nonce });
    if (recomputed === stored.art12.record_hash) {
      // FIX-BACK-3 (M1): a stored anchor whose tx the node has NO record
      // of ("transaction not found") is dead — the send returned a hash
      // for a tx that was never finalized, and the old code re-reported
      // that hash forever because the re-anchor branch only fired when
      // anchor_tx was null. A dead anchor is treated exactly like a null
      // one: cleared and re-anchored for the SAME record hash below. The
      // dead hash is kept in `anchor_recovered_from` for audit. Any other
      // non-finalized read-back (received / committed / transient error)
      // keeps the stored hash — the tx may still land.
      const anchor = stored.art12.anchor_tx ? await verifyRecordAnchor(stored.art12.anchor_tx) : { ok: false, reason: 'not_anchored' };
      const deadAnchor = stored.art12.anchor_tx && !anchor.ok && isDeadAnchor(anchor) ? stored.art12.anchor_tx : null;
      if (!stored.art12.anchor_tx || deadAnchor) {
        // First-build anchor failed transiently — or the stored anchor is
        // dead (see above). Re-attempt it now for the same record hash
        // (nonce-retry + finality confirmation inside anchorRecordHash).
        const reanchored = await anchorRecordHash(stored.art12.record_hash);
        if (reanchored.txHash) {
          receipt.art12 = {
            ...stored.art12,
            anchor_tx: reanchored.txHash,
            anchor_url: reanchored.explorerUrl,
            anchor_status: 'anchored',
            anchor_verified_at: null,
            ...(deadAnchor ? { anchor_recovered_from: deadAnchor } : {}),
          };
        } else {
          receipt.art12 = {
            ...stored.art12,
            anchor_tx: null,
            anchor_url: null,
            anchor_status: `not_anchored (${reanchored.error ?? 're-anchor failed'})`,
            anchor_verified_at: stored.art12.anchor_verified_at ?? null,
            ...(deadAnchor ? { anchor_recovered_from: deadAnchor } : {}),
          };
        }
        await saveReceipt(receipt);
        return receipt;
      }
      receipt.art12 = {
        ...stored.art12,
        anchor_status: anchor.ok ? 'verified' : `anchor_tx_${anchor.status ?? anchor.reason}`,
        anchor_verified_at: anchor.ok ? new Date().toISOString() : stored.art12.anchor_verified_at ?? null,
      };
      await saveReceipt(receipt);
      return receipt;
    }
  }
  const core = buildArt12Core({ payableId, view, txs, verifier, consent });
  const nonce = randomBytes(16).toString('hex');
  const recordWithoutHash = { ...core, nonce };
  const recordHash = receiptBuild.computeRecordHash(recordWithoutHash);
  const anchored = await anchorRecordHash(recordHash);
  receipt.art12 = {
    ...recordWithoutHash,
    record_hash: recordHash,
    anchor_tx: anchored.txHash ?? null,
    anchor_url: anchored.explorerUrl ?? null,
    anchor_status: anchored.txHash ? 'anchored' : `not_anchored (${anchored.error ?? 'no signer on this host'})`,
    anchor_verified_at: null,
  };
  await saveReceipt(receipt);
  return receipt;
}
