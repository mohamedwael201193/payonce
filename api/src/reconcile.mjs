// PayOnce API server — startup reconciliation (testnet only).
// The chain is the source of truth for payable status; the DB is the
// source of truth for server-side state (jobs, receipts, counters).
// On boot, reconcile the two:
//   1. Discover fresh ids on chain (probe FRESH_ID_START upward until 3
//      consecutive missing ids, cap 50) — finds payables an ephemeral
//      store lost (e.g. 1005, paid live 2026-11-24 but absent from the
//      restarted server's store) and merges them into counters.freshIds;
//      advances nextFreshId past the highest existing id.
//   2. For every Paid payable with no receipt in the store, rebuild it:
//      CCD -> recover the pay tx from the chain (event scan, recover.mjs),
//      store a provisional receipt, then buildReceiptFor() re-verifies
//      (10/10) and stores the full receipt. EUDemo -> buildReceiptFor()
//      directly (the view names the transfer; source 'chain').
// Never throws: per-payable failures are collected and reported in the
// summary, so a recovery failure degrades to a missing receipt (the old
// behaviour) instead of taking the API down.
import { createHash } from 'node:crypto';
import { grpc, getPayableOrNull, SELLER } from './chain-v2.mjs';
import { FRESH_ID_START, txUrl } from './config.mjs';
import { loadCounters, saveCounters, loadReceipts, saveReceipt, receiptKey } from './store.mjs';
import { buildReceiptFor } from './receipts.mjs';
import { recoverCcdPaymentTx } from './recover.mjs';
import { docForPayable, generateLabDocument, storeDocument } from './docs.mjs';

const KNOWN_IDS = [1, 2, 3, 4, 5, 10, 11];

export async function reconcile() {
  const discovered = [];
  const rebuilt = [];
  const recoveredDocs = [];
  const failed = [];
  try {
    const c = await grpc();
    // 1. Discover fresh ids on chain.
    const counters = await loadCounters();
    const known = new Set([...KNOWN_IDS, ...(counters.freshIds ?? [])]);
    let missing = 0;
    for (let id = FRESH_ID_START; id < FRESH_ID_START + 50 && missing < 3; id += 1) {
      let view = null;
      try { view = await getPayableOrNull(c, SELLER, id); } catch { /* treat as missing for this probe */ }
      if (view) {
        missing = 0;
        if (!known.has(id)) { known.add(id); discovered.push(id); }
      } else {
        missing += 1;
      }
    }
    const freshIds = [...known].filter((id) => id >= FRESH_ID_START).sort((a, b) => a - b);
    const maxId = freshIds.length ? Math.max(...freshIds) : FRESH_ID_START - 1;
    const nextFreshId = Math.max(counters.nextFreshId, maxId + 1);
    if (discovered.length || nextFreshId !== counters.nextFreshId || JSON.stringify(freshIds) !== JSON.stringify(counters.freshIds ?? [])) {
      counters.freshIds = freshIds;
      counters.nextFreshId = nextFreshId;
      await saveCounters(counters);
    }
    // 2. Rebuild missing receipts for Paid payables.
    const receipts = await loadReceipts();
    for (const id of [...known].sort((a, b) => a - b)) {
      if (receipts[receiptKey(SELLER, id)]) continue;
      try {
        const view = await getPayableOrNull(c, SELLER, id);
        if (!view || view.status !== 'Paid') continue;
        // The lab document for a fresh payable is deterministic given the
        // on-chain view (id, asset, amount, payee, seller, due) — the same
        // generateLabDocument() the create handler used. When the stored
        // copy was lost with the ephemeral disk (as 1005's was), regenerate
        // it and accept it ONLY when its hash equals the on-chain doc_hash.
        if (id >= FRESH_ID_START && !(await docForPayable(id))) {
          const text = generateLabDocument({ id, asset: view.asset, amount: view.amount, payee: view.payee, seller: view.seller, due: view.dueMs });
          const hash = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
          if (hash === view.docHash) {
            await storeDocument(id, text);
            recoveredDocs.push(id);
          } else {
            failed.push({ id, reason: 'lab document not regenerable (hash mismatch)' });
          }
        }
        if (view.asset === 'CCD') {
          const txHash = await recoverCcdPaymentTx(id);
          if (!txHash) { failed.push({ id, reason: 'payment_tx not recoverable from chain' }); continue; }
          await saveReceipt({
            payable_id: id,
            // Reconcile only ever rebuilds seller-1 receipts (it scans
            // seller 1's known ids); stored under the (seller 1, id)
            // key (fix-back §4.2).
            seller: view.seller,
            amount_display: '',
            payee: view.payee,
            payer_label: 'Demo payer account (lab)',
            txs: [{ label: 'Payment', tx_hash: txHash, explorer_url: txUrl(txHash) }],
            verifier: null,
            payment_tx_source: 'server_store',
          });
        }
        const receipt = await buildReceiptFor(id);
        if (receipt) {
          rebuilt.push({ id, source: receipt.payment_tx_source, verifier: receipt.verifier ? `${receipt.verifier.passed}/${receipt.verifier.total}` : 'null' });
        } else {
          failed.push({ id, reason: 'buildReceiptFor returned null' });
        }
      } catch (e) {
        failed.push({ id, reason: e.message });
      }
    }
  } catch (e) {
    failed.push({ id: null, reason: `reconcile top-level: ${e.message}` });
  }
  const line = `discovered fresh ids [${discovered.join(',') || 'none'}], recovered documents [${recoveredDocs.join(',') || 'none'}], rebuilt receipts [${rebuilt.map((r) => `${r.id} (${r.source}, verifier ${r.verifier})`).join(', ') || 'none'}]${failed.length ? `, FAILED [${failed.map((f) => `${f.id}: ${f.reason}`).join('; ')}]` : ''}`;
  return { discovered, rebuilt, recoveredDocs, failed, line };
}
