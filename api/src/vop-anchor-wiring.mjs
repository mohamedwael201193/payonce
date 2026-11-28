// Real chain/store dependencies for vop-anchor.mjs (kept apart so the service tests need no chain).
import { Transaction, DataBlob, TransactionExpiry, AccountAddress, SequenceNumber } from '@concordium/web-sdk';
import { grpc, signers, nextNonce, withNonceRetry, getTx } from './chain-v2.mjs';
import { waitForAnchorFinalized } from './receipts.mjs';
import { kvGet, kvPut, kvPutIfAbsent } from './store.mjs';
import { txUrl } from './config.mjs';

// Errors the node raises BEFORE it accepts a transaction: nothing was sent, a retry cannot double-send.
const PRE_ACCEPT = /duplicate nonce|RESOURCE_EXHAUSTED|UNAVAILABLE|HTTP status code (429|502|503|504)|ECONNREFUSED/i;

export async function sendRegisterData(dataHex) {
  try {
    return await withNonceRetry(async () => {
      const c = await grpc(); const { owner } = await signers();
      const nonce = await nextNonce(c, owner.address);
      const data = new DataBlob(Uint8Array.from(Buffer.from(dataHex, 'hex')).buffer);
      const tx = Transaction.registerData({ data }).addMetadata({ sender: AccountAddress.fromBase58(owner.address), nonce: SequenceNumber.create(nonce), expiry: TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)) });
      const finalized = await Transaction.signAndFinalize(tx.build(), owner.signer);
      const hash = await c.sendTransaction(finalized);
      return { txHash: (typeof hash === 'string' ? hash : Buffer.from(hash.buffer ?? hash).toString('hex')).toLowerCase() };
    });
  } catch (e) { if (PRE_ACCEPT.test(String(e?.message ?? e))) e.notSent = true; throw e; }
}

/** Hex of the data a finalized registerData transaction carries (summary.dataRegistered.data, whatever the JSON shape of RegisteredData is). */
export function registeredDataHex(summary) {
  const strings = [];
  const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(summary?.dataRegistered);
  const hex = strings.find((x) => /^[0-9a-fA-F]+$/.test(x) && x.length >= 10);
  return hex ? hex.toLowerCase() : null;
}
/** Hex of a PayOnce verdict receipt ("PVOP1" + 32-byte evidence_hash) if it appears on a CCDExplorer transaction page. */
export function dataHexFromExplorerHtml(html) {
  const m = String(html).match(/50564[fF]5031[0-9a-fA-F]{64}/);
  return m ? m[0].toLowerCase() : null;
}

/** Public, unauthenticated fallback when the testnet node rate-limits a read. Labelled `source: ccdexplorer`. */
export async function explorerTxStatus(txHash, fetchImpl = fetch) {
  const r = await fetchImpl(`https://ccdexplorer.io/testnet/transaction/${txHash}`, { headers: { 'user-agent': 'payonce-check-payee/1.0' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`explorer HTTP ${r.status}`);
  const dataHex = dataHexFromExplorerHtml(await r.text());
  if (!dataHex) throw new Error('explorer page had no registered PVOP1 data');
  return { status: 'finalized', dataHex, source: 'ccdexplorer' };
}

const NODE_RETRY = /429|RESOURCE_EXHAUSTED|UNAVAILABLE|ETIMEDOUT|ECONNRESET/i;
/** Node first (retried on 429); CCDExplorer HTML if the node still will not answer. */
export async function resolveTxStatus(txHash, { fromNode, fromExplorer = explorerTxStatus } = {}) {
  let last;
  for (let i = 0; i < 4; i++) {
    try { const s = await fromNode(txHash); return { status: s.status, dataHex: s.dataHex ?? null, sender: s.sender ?? null, source: 'node' }; }
    catch (e) { last = e; if (!NODE_RETRY.test(String(e?.message ?? e))) throw e; await new Promise((r) => setTimeout(r, 1200 * (i + 1))); }
  }
  try { return await fromExplorer(txHash); }
  catch { throw last; }
}

export async function txStatus(txHash) {
  return resolveTxStatus(txHash, { fromNode: async (h) => { const s = await getTx(await grpc(), h); return { status: s.status, dataHex: registeredDataHex(s.summary) }; } });
}

export const anchorDeps = (hitWindow) => ({
  kv: { get: kvGet, put: kvPut, putIfAbsent: kvPutIfAbsent },
  send: sendRegisterData, status: txStatus, waitFinalized: (h) => waitForAnchorFinalized(h, 30, 2000), explorer: txUrl,
  budget: async (ip) => { const w = await hitWindow(`vop:anchor:${ip}`, 3_600_000, 3); return { allowed: w.allowed, retryAfterS: Math.ceil((w.resetMs ?? 0) / 1000) }; },
});
