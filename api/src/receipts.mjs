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
// CCD / 12 checks EUDemo), plus the two receipt-binding extras
// (stored-tx-hash, paid_at == confirm block time) run inside the
// re-verification.
import { backend } from './backend.mjs';
import {
  grpc, getPayableOrNull, getRegistryBalance, getTx, getBlockTime,
  SELLER,
} from './chain-v2.mjs';
import { verifyCcdV2, verifyPltV2, pltReceiptExtraChecks } from './verifier-v2.mjs';
import { docForPayable, recordedPaymentTx } from './docs.mjs';
import { loadReceipts, saveReceipts, loadCounters, saveCounters } from './store.mjs';
import { REGISTRY, txUrl } from './config.mjs';

/** Payment transactions for a paid payable, from the store then evidence. */
export function paymentTxsFor(payableId, view) {
  const receipts = loadReceipts();
  const stored = receipts[payableId];
  if (stored?.txs?.length) {
    return {
      txs: stored.txs.map((t) => [t.label, t.tx_hash]),
      source: stored.payment_tx_source,
    };
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

/** Build (and store) the receipt for a paid payable. Returns null when
 *  the payable is not Paid, or when the payment tx hash is unknown. */
export async function buildReceiptFor(payableId) {
  const c = await grpc();
  const view = await getPayableOrNull(c, SELLER, payableId);
  if (!view || view.status !== 'Paid') return null;
  const { txs, source } = paymentTxsFor(payableId, view);
  if (txs.length === 0) return null;
  const docBytes = docForPayable(payableId);
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
      const transferHash = txs.find(([l]) => l === 'Transfer')?.[1];
      const confirmHash = txs.find(([l]) => l === 'Confirm')?.[1];
      if (transferHash) {
        const summary = await getTx(c, transferHash);
        const blockTime = await getBlockTime(c, summary.blockHash);
        let confirm = null;
        if (confirmHash) {
          const cs = await getTx(c, confirmHash);
          confirm = { blockTime: await getBlockTime(c, cs.blockHash) };
        }
        const result = await verifyPltV2(c, {
          payableId, txHash: transferHash, summary, blockTime, view, balance, docBytes, confirm,
        });
        const extras = pltReceiptExtraChecks(view, transferHash, confirm);
        const extraPassed = extras.filter((ch) => ch.status === 'ok').length;
        verifier = {
          passed: result.passed + extraPassed,
          total: result.total + extras.length,
          checked_at: new Date().toISOString(),
        };
      }
    }
    const counters = loadCounters();
    counters.verifierRuns += 1;
    if (verifier && verifier.passed === verifier.total) counters.verifierPassed += 1;
    else counters.verifierFailed += 1;
    counters.lastVerifierRunAt = new Date().toISOString();
    saveCounters(counters);
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
    amount_display: amountDisplay,
    payee: view.payee,
    payer_label: 'Demo payer account (lab)',
    txs: txs.map(([label, hash]) => ({ label, tx_hash: hash, explorer_url: txUrl(hash) })),
    verifier,
    payment_tx_source: source,
  };
  const receipts = loadReceipts();
  receipts[payableId] = receipt;
  saveReceipts(receipts);
  return receipt;
}
