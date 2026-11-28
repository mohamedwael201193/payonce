// Chain and store wiring for mandate.mjs: the buyer account (agent #1488) signs the mandate and sends its anchor itself.
import { Transaction, DataBlob, TransactionExpiry, AccountAddress, SequenceNumber, signMessage } from '@concordium/web-sdk';
import { grpc, signers, nextNonce, withNonceRetry, getTx } from './chain-v2.mjs';
import { kvGet, kvPut, kvPutIfAbsent, kvList } from './store.mjs';
import { txUrl, BUYER_TOKEN_ID } from './config.mjs';
import { vClient } from './consent.mjs';
import { resolveTxStatus, registeredDataHex } from './vop-anchor-wiring.mjs';

const PRE_ACCEPT = /duplicate nonce|RESOURCE_EXHAUSTED|UNAVAILABLE|HTTP status code (429|502|503|504)|ECONNREFUSED/i;
const buyerSigner = async () => (await signers()).sellerB; // 4MvdME…, the account of agent #1488

export async function sendBuyerRegisterData(dataHex) {
  try {
    return await withNonceRetry(async () => {
      const c = await grpc(); const b = await buyerSigner();
      const nonce = await nextNonce(c, b.address);
      const data = new DataBlob(Uint8Array.from(Buffer.from(dataHex, 'hex')).buffer);
      const tx = Transaction.registerData({ data }).addMetadata({ sender: AccountAddress.fromBase58(b.address), nonce: SequenceNumber.create(nonce), expiry: TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)) });
      const finalized = await Transaction.signAndFinalize(tx.build(), b.signer);
      const hash = await c.sendTransaction(finalized);
      return { txHash: (typeof hash === 'string' ? hash : Buffer.from(hash.buffer ?? hash).toString('hex')).toLowerCase() };
    });
  } catch (e) { if (PRE_ACCEPT.test(String(e?.message ?? e))) e.notSent = true; throw e; }
}

export async function anchorStatusWithSender(txHash) {
  const r = await resolveTxStatus(txHash, { fromNode: async (h) => { const s = await getTx(await grpc(), h); return { status: s.status, dataHex: registeredDataHex(s.summary), sender: s.summary?.sender ?? null }; } });
  return r;
}

export async function buyerAccount() { return (await buyerSigner()).address; }

/** deps for createMandates(); `buyer` is filled lazily because the signer loads on first use. */
export async function mandateDeps() {
  const b = await buyerSigner();
  return {
    kv: { get: kvGet, put: kvPut, putIfAbsent: kvPutIfAbsent, list: kvList },
    accountInfo: (a) => vClient().getAccountInfo(AccountAddress.fromBase58(a)),
    anchorStatus: anchorStatusWithSender, explorer: txUrl,
    buyer: { account: b.address, agent_token: BUYER_TOKEN_ID, sign: (message) => signMessage(AccountAddress.fromBase58(b.address), message, b.signer), sendAnchor: sendBuyerRegisterData },
  };
}
