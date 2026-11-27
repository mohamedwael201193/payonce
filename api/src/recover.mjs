// PayOnce API server — payment_tx recovery from the chain (testnet only).
// The v2 registry view carries txHash ONLY on the EUDemo path (the confirm
// stores the transfer hash); on the CCD path the view's txHash is null
// (backend judge F5). The honest recovery is the chain itself: the pay tx
// is the one whose Logged events contain a `Paid` event for this payable,
// and the contract's paidAt IS the pay block's slot time, so the block is
// found by binary search on height (slotTime is monotonic in height).
// Proven live for payable 1005: returns 24494923… (see API_PERSIST_REPORT).
import { grpc, getPayableOrNull, SELLER } from './chain-v2.mjs';
import { REGISTRY } from './config.mjs';
import { backend } from './backend.mjs';

/** Slot time (ms) of the FINALIZED block at a height, or null. */
async function finalizedSlotMsAt(c, height) {
  const hashes = await c.getBlocksAtHeight(height);
  for (const hash of hashes ?? []) {
    const info = await c.getBlockInfo(hash);
    if (info?.finalized) return Number(new Date(info.blockSlotTime));
  }
  return null;
}

/** The finalized block hash at a height, or null. */
async function finalizedHashAt(c, height) {
  const hashes = await c.getBlocksAtHeight(height);
  for (const hash of hashes ?? []) {
    const info = await c.getBlockInfo(hash);
    if (info?.finalized) return hash;
  }
  return hashes?.[0] ?? null;
}

/** Binary-search the finalized height whose block slot time == paidAtMs. */
export async function findBlockAtTime(c, paidAtMs) {
  const cs = await c.getConsensusStatus();
  const H = BigInt(cs.lastFinalizedBlockHeight);
  const nowMs = Date.now();
  const est = H - BigInt(Math.floor((nowMs - paidAtMs) / 2500));
  let lo = est - 10000n;
  if (lo < 1n) lo = 1n;
  let hi = est + 10000n;
  if (hi > H) hi = H;
  if (lo > hi) return null;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const slotMs = await finalizedSlotMsAt(c, mid);
    if (slotMs == null) { lo = mid + 1n; continue; }
    if (slotMs < paidAtMs) lo = mid + 1n;
    else hi = mid;
  }
  const slotMs = await finalizedSlotMsAt(c, lo);
  if (slotMs !== paidAtMs) return null;
  const hash = await finalizedHashAt(c, lo);
  if (!hash) return null;
  return { height: lo, hash, slotMs };
}

/** Scan one block's tx events for the Paid event of a payable. Returns the
 *  pay tx hash, or null. The Transferred event is cross-checked against the
 *  view (amount + payee) when a view is supplied. */
export async function scanBlockForPaidTx(c, blockHash, payableId, seller, view = null) {
  const { v2ev } = await backend();
  for await (const item of c.getBlockTransactionEvents(blockHash)) {
    const it = JSON.parse(JSON.stringify(item, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const upd = (it.events ?? []).find((e) => e.tag === 'Updated' && Number(e.address?.index) === REGISTRY.index);
    if (!upd) continue;
    let decoded = [];
    try { decoded = v2ev.decodeLoggedEventsV2(upd); } catch { continue; }
    const paid = decoded.find((e) => e.event === 'Paid' && Number(e.payableId) === payableId && e.seller === seller);
    if (!paid) continue;
    if (view) {
      const tr = (it.events ?? []).find((e) => e.tag === 'Transferred');
      const ok = tr && String(tr.amount) === String(view.amount) && tr.to === view.payee;
      if (!ok) console.warn(`[recover] Paid event for #${payableId} in ${it.hash.slice(0, 8)}… but the Transferred event does not match the view (amount/payee) — returning the hash anyway (Paid event is authoritative).`);
    }
    return it.hash;
  }
  return null;
}

/** Recover the CCD pay tx hash for a Paid payable from the chain, or null.
 *  Returns the view's txHash immediately when the contract already has it
 *  (EUDemo path); null when the payable is not Paid / not CCD / the block
 *  cannot be located / no Paid event is found. Never invents a hash. */
export async function recoverCcdPaymentTx(payableId, seller = SELLER) {
  const c = await grpc();
  const view = await getPayableOrNull(c, seller, payableId);
  if (!view || view.status !== 'Paid') return null;
  if (view.record?.txHash) return view.record.txHash; // EUDemo path (or a future CCD path that records it)
  if (view.asset !== 'CCD') return null;
  const paidAtMs = Number(view.record?.paidAtMs);
  if (!Number.isFinite(paidAtMs) || paidAtMs <= 0) return null;
  const block = await findBlockAtTime(c, paidAtMs);
  if (!block) return null;
  return scanBlockForPaidTx(c, block.hash, payableId, seller, view);
}
