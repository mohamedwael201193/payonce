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
export async function txStatus(txHash) {
  const s = await getTx(await grpc(), txHash);
  return { status: s.status, dataHex: registeredDataHex(s.summary) };
}

export const anchorDeps = (hitWindow) => ({
  kv: { get: kvGet, put: kvPut, putIfAbsent: kvPutIfAbsent },
  send: sendRegisterData, status: txStatus, waitFinalized: (h) => waitForAnchorFinalized(h, 30, 2000), explorer: txUrl,
  budget: async (ip) => { const w = await hitWindow(`vop:anchor:${ip}`, 3_600_000, 3); return { allowed: w.allowed, retryAfterS: Math.ceil((w.resetMs ?? 0) / 1000) }; },
});
