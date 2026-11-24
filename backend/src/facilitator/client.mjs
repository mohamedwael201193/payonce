// PayOnce backend — x402 client-side builders (testnet only).
// Two builders:
//   1. buildCcdPaymentPayload — the stock @x402/concordium client (simple CCD
//      transfer to the payee, sponsored). No memo exists for CCD.
//   2. buildMemoPltPayload — a custom v1 sponsored PLT transfer WITH the
//      canonical CBOR memo `payable:<id>`. The stock x402 client sets
//      memo: void 0, so PayOnce builds this one with the web-sdk directly:
//      Transaction.tokenUpdate -> addMetadata -> addSponsor -> build ->
//      sign as sender -> toJSON (BigInt-safe, as the x402 client does).
//      The result is a standard x402 PaymentPayload the facilitator's
//      verify()/settle() accept unchanged.
import { ExactConcordiumScheme as ClientScheme } from '@x402/concordium/exact/client';
import { Transaction, Payload, Cbor, CborMemo, TokenAmount, CborAccountAddress, TokenId, AccountAddress, TransactionExpiry, SequenceNumber } from '@concordium/web-sdk';
import { TESTNET_CAIP2 } from './scheme.mjs';
import { nextNonce } from '../send.mjs';

/** BigInt-safe JSON (mirrors the x402 client's toJsonSafe). */
export function toJsonSafe(value) {
  if (typeof value === 'bigint') return value <= 9007199254740991n ? Number(value) : value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  return value;
}

/** Stock x402 client: build + sender-sign a sponsored CCD simple transfer. */
export async function buildCcdPaymentPayload({ buyer, requirements }) {
  const client = new ClientScheme({ accountAddress: AccountAddress.fromBase58(buyer.address), signer: buyer.signer });
  const { x402Version, payload } = await client.createPaymentPayload(2, requirements);
  return { x402Version, accepted: { scheme: 'exact', network: TESTNET_CAIP2 }, payload };
}

/**
 * Custom v1 sponsored PLT transfer with the canonical memo `payable:<id>`.
 * expirySeconds is an absolute epoch-seconds header expiry (the caller must
 * bound it: for PayOnce Rail B, <= reservation expiry - 60s).
 */
export async function buildMemoPltPayload({ grpc, sender, sponsorAddress, recipient, amount, tokenId = 'EUDemo', memo, expirySeconds }) {
  const nonce = await nextNonce(grpc, sender.address);
  const operations = Cbor.encode([{
    transfer: {
      amount: TokenAmount.create(BigInt(amount), 6),
      recipient: CborAccountAddress.fromBase58(recipient),
      memo: CborMemo.fromString(memo),
    },
  }]);
  const payload = Payload.tokenUpdate({ tokenId: TokenId.fromString(tokenId), operations });
  const tx = Transaction.tokenUpdate(payload).addMetadata({
    sender: AccountAddress.fromBase58(sender.address),
    nonce: SequenceNumber.create(nonce),
    expiry: TransactionExpiry.fromEpochSeconds(expirySeconds),
  }).addSponsor(AccountAddress.fromBase58(sponsorAddress)).build();
  const signed = await Transaction.sign(tx, sender.signer);
  return {
    x402Version: 2,
    accepted: { scheme: 'exact', network: TESTNET_CAIP2 },
    payload: { signedTransaction: toJsonSafe(Transaction.toJSON(signed)) },
  };
}
