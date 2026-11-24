// PayOnce backend — v2 transaction sender (testnet only).
// Same mechanics as src/send.mjs but targeting <13150,0> /
// payable_registry_v2. The v1 sendUpdate (REGISTRY <13149,0>) is NOT
// touched — the v1 run stays intact.
import {
  AccountAddress,
  ContractAddress,
  TransactionExpiry,
  CcdAmount,
  Energy,
  ReceiveName,
  Parameter,
  SequenceNumber,
} from '@concordium/web-sdk';
import { Transaction, Payload } from '@concordium/web-sdk';
import { nextNonce, waitFinalized } from '../send.mjs';
import { REGISTRY_V2, CONTRACT_NAME_V2 } from './registry.mjs';

export { nextNonce, waitFinalized };

/** Build + sign + submit a v2 contract update. Returns { txHash, nonce }.
 * maxEnergy default 6000: the node requires balance >= maxEnergy x rate
 * (~0.0078 CCD/NRG), so a 30000 cap (~234 CCD) exceeds B's balance and
 * the node rejects the send outright; actual v2 calls use 700-3100 NRG. */
export async function sendUpdateV2(client, { from, receiveName, parameterHex, amountMicroCcd = 0n, maxEnergy = 6000n, expiryMinutes = 5 }) {
  const nonce = await nextNonce(client, from.address);
  const payload = Payload.updateContract({
    amount: CcdAmount.fromMicroCcd(amountMicroCcd),
    address: ContractAddress.create(REGISTRY_V2.index, REGISTRY_V2.subindex),
    receiveName: ReceiveName.fromString(`${CONTRACT_NAME_V2}.${receiveName}`),
    message: Parameter.fromHexString(parameterHex),
  });
  const tx = Transaction.updateContract(payload, Energy.create(maxEnergy)).addMetadata({
    sender: AccountAddress.fromBase58(from.address),
    nonce: SequenceNumber.create(nonce),
    expiry: TransactionExpiry.futureMinutes(expiryMinutes),
  });
  const finalized = await Transaction.signAndFinalize(tx.build(), from.signer);
  const hash = await client.sendTransaction(finalized);
  const txHash = typeof hash === 'string' ? hash : hash.toString();
  return { txHash, nonce };
}

/** Build + sign + submit a plain CCD transfer. Returns { txHash, nonce }. */
export async function sendSimpleTransfer(client, { from, to, amountMicroCcd, maxEnergy = 1000n, expiryMinutes = 5 }) {
  const nonce = await nextNonce(client, from.address);
  const payload = Payload.transfer({
    amount: CcdAmount.fromMicroCcd(amountMicroCcd),
    toAddress: AccountAddress.fromBase58(to),
  });
  const tx = Transaction.transfer(payload).addMetadata({
    sender: AccountAddress.fromBase58(from.address),
    nonce: SequenceNumber.create(nonce),
    expiry: TransactionExpiry.futureMinutes(expiryMinutes),
  });
  const finalized = await Transaction.signAndFinalize(tx.build(), from.signer);
  const hash = await client.sendTransaction(finalized);
  const txHash = typeof hash === 'string' ? hash : hash.toString();
  return { txHash, nonce };
}

/** Extract the reject reason (if any) from a finalized tx status. */
export function rejectReasonOf(status) {
  try {
    const sj = JSON.stringify(status, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const s = JSON.parse(sj);
    const rr = s.outcome?.summary?.rejectReason;
    if (rr) return rr;
    const m = sj.match(/"rejectReason":\s*(-?\d+)/);
    if (m) return { rejectReason: Number(m[1]) };
  } catch { /* fall through */ }
  return null;
}

/** Compact summary of a finalized tx: outcome, cost, energy, reject reason. */
export function summarizeTx(status) {
  const s = status.summary ?? {};
  const rr = rejectReasonOf(status);
  return {
    status: status.status,
    blockHash: status.blockHash,
    outcome: s.transactionType === 'update' && rr ? `REJECT ${rr.rejectReason}` : s.transactionType ?? null,
    rejectReason: rr?.rejectReason ?? null,
    costMicroCcd: s.cost ?? null,
    costCcd: s.cost != null ? (Number(s.cost) / 1e6).toString() : null,
    energy: s.energyCost?.value ?? s.energyCost ?? null,
  };
}
