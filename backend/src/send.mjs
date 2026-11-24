// PayOnce backend — live transaction sender (testnet only).
// Loads the wallet keys IN-PROCESS ONLY from the env (never prints, logs or
// stores them): the owner key from CONCORDIUM_WALLET_PRIVATE_KEY, and the
// seller-B + agent-C3 keys derived from CONCORDIUM_WALLET_SEED_PHRASE via the
// SDK's ConcordiumHdWallet (derivation proven by the spikes/derive-keys.mjs
// probe: identity 1, counter 0 = owner, 1 = seller B, 3 = agent C3 key 0).
// C3's keys 1-2 are NOT in the seed (1 of 3 found in the probe) — a 2-of-3
// C3 transaction cannot be submitted from here; the live E2E therefore runs
// the buyer as the owner account and the seller as B, with the co-signer
// service acting as the decision gate (its signature is recorded as an
// attestation in the ledger + receipt, not as an on-chain co-signature).
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import {
  ConcordiumHdWallet,
  AccountAddress,
  ContractAddress,
  TransactionExpiry,
  CcdAmount,
  Energy,
  ReceiveName,
  Parameter,
  SequenceNumber,
} from '@concordium/web-sdk';
import { Transaction, Payload, Cbor, CborMemo, TokenAmount, CborAccountAddress, TokenId } from '@concordium/web-sdk';
import { buildBasicAccountSigner } from '@concordium/web-sdk';
import { grpcClient, getAccountInfo, getTxStatus, getBlockTime, encodeCborMemo } from './chain.mjs';

const ENV_PATH = '/home/hatch/workspace/concordium-trusted-agents/.env';

export const OWNER_ADDRESS = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
export const SELLER_B_ADDRESS = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';
export const AGENT_C3_ADDRESS = '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n';
export const PAYEE2_ADDRESS = '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg';
export const REGISTRY = { index: 13149n, subindex: 0n };

function loadEnv() {
  return parse(readFileSync(ENV_PATH, 'utf8'));
}

/** Account signers, built in-process. Keys never leave this module's memory. */
export function loadSigners() {
  const env = loadEnv();
  const owner = buildBasicAccountSigner(env.CONCORDIUM_WALLET_PRIVATE_KEY);
  const wallet = ConcordiumHdWallet.fromSeedPhrase(env.CONCORDIUM_WALLET_SEED_PHRASE, 'Testnet');
  const sellerB = buildBasicAccountSigner(wallet.getAccountSigningKey(0, 1, 1).toString('hex'));
  const agentC3Key0 = buildBasicAccountSigner(wallet.getAccountSigningKey(0, 1, 3).toString('hex'));
  return {
    owner: { address: OWNER_ADDRESS, signer: owner },
    sellerB: { address: SELLER_B_ADDRESS, signer: sellerB },
    agentC3Key0: { address: AGENT_C3_ADDRESS, signer: agentC3Key0 },
  };
}

export async function nextNonce(client, address) {
  const consensus = JSON.parse(JSON.stringify(await client.getConsensusStatus(), (k, x) => (typeof x === 'bigint' ? x.toString() : x)));
  const info = await getAccountInfo(client, address, consensus.lastFinalizedBlock);
  return Number(info.accountNonce);
}

/** Wait until a tx is finalized (or the deadline passes). Returns the status. */
export async function waitFinalized(client, txHash, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await getTxStatus(client, txHash);
      if (last.status === 'finalized') return last;
    } catch {
      // Not seen yet.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`tx ${txHash} did not finalize within ${timeoutMs}ms (last: ${last?.status ?? 'not-found'})`);
}

async function submit(client, tx) {
  const hash = await client.sendTransaction(tx);
  return typeof hash === 'string' ? hash : hash.toString();
}

/** Build + sign + submit a contract update. Returns { txHash, tx }. */
export async function sendUpdate(client, { from, receiveName, parameterHex, amountMicroCcd = 0n, maxEnergy = 10000n, expiryMinutes = 5 }) {
  const nonce = await nextNonce(client, from.address);
  const payload = Payload.updateContract({
    amount: CcdAmount.fromMicroCcd(amountMicroCcd),
    address: ContractAddress.create(REGISTRY.index, REGISTRY.subindex),
    receiveName: ReceiveName.fromString(`payable_registry.${receiveName}`),
    message: Parameter.fromHexString(parameterHex),
  });
  const tx = Transaction.updateContract(payload, Energy.create(maxEnergy)).addMetadata({
    sender: AccountAddress.fromBase58(from.address),
    nonce: SequenceNumber.create(nonce),
    expiry: TransactionExpiry.futureMinutes(expiryMinutes),
  });
  const finalized = await Transaction.signAndFinalize(tx.build(), from.signer);
  const txHash = await submit(client, finalized);
  return { txHash, nonce };
}

/** Build + sign + submit a PLT token transfer with a CBOR memo. */
export async function sendTokenTransfer(client, { from, recipient, amount, tokenId = 'EUDemo', memo, expirySeconds }) {
  const nonce = await nextNonce(client, from.address);
  const operations = Cbor.encode([
    {
      transfer: {
        amount: TokenAmount.create(BigInt(amount), 6),
        recipient: CborAccountAddress.fromBase58(recipient),
        memo: CborMemo.fromString(memo),
      },
    },
  ]);
  // Dry-run check: the encoded operations must contain, verbatim, the canonical
  // CBOR memo bytes and the recipient's 32-byte address. (The SDK's typed
  // Cbor.decode('TokenOperation[]') round-trip rejects its own plain-object
  // output, so the byte-level check is the reliable one here.)
  const opsHex = Buffer.from(operations.bytes).toString('hex');
  const memoHex = encodeCborMemo(memo).toString('hex');
  // The recipient is CBOR-encoded as its 32 raw address bytes.
  const recipientHex = Buffer.from(AccountAddress.toBuffer(AccountAddress.fromBase58(recipient))).toString('hex');
  if (!opsHex.includes(memoHex)) throw new Error(`memo bytes ${memoHex} missing from encoded operations`);
  if (!opsHex.includes(recipientHex)) throw new Error(`recipient address missing from encoded operations`);
  const payload = Payload.tokenUpdate({ tokenId: TokenId.fromString(tokenId), operations });
  let tx = Transaction.tokenUpdate(payload).addMetadata({
    sender: AccountAddress.fromBase58(from.address),
    nonce: SequenceNumber.create(nonce),
    expiry: TransactionExpiry.fromDate(new Date(expirySeconds * 1000)),
  });
  const finalized = await Transaction.signAndFinalize(tx.build(), from.signer);
  const txHash = await submit(client, finalized);
  return { txHash, nonce };
}

/** Encode a v1 register_payable parameter (layout proven from tx d8986836). */
export function encodeRegisterPayable({ payableId, payee, amount, asset, dueMs, docHashHex, agentToken }) {
  const parts = [];
  const u64 = (v) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    return b;
  };
  parts.push(u64(payableId));
  parts.push(Buffer.from(AccountAddress.toBuffer(AccountAddress.fromBase58(payee))));
  parts.push(u64(amount));
  if (asset === 'CCD') {
    parts.push(Buffer.from([0x00]));
  } else {
    const sym = Buffer.from(asset, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(sym.length);
    parts.push(Buffer.from([0x01]), len, sym);
  }
  parts.push(u64(dueMs));
  parts.push(Buffer.from(docHashHex, 'hex'));
  // agent_token: Vec<u8> = u32 LE length (8) + token id as raw u64 LE.
  // The contract wraps these bytes in U8Bytes for the agentOf cross-call,
  // producing the 9-byte TokenIdU64 wire form 08 + u64 LE.
  // PROVEN from the original registration tx d8986836…: tail after doc_hash
  // is 08000000 0100000000000000 — NOT a bare u64 + 4 trailing zero bytes
  // (the earlier reading was wrong and caused a -11 RegistryCallFailed).
  const tokenLen = Buffer.alloc(4);
  tokenLen.writeUInt32LE(8);
  parts.push(tokenLen);
  parts.push(u64(agentToken));
  return Buffer.concat(parts).toString('hex');
}

/** Encode a v1 pay_ccd / reserve_plt parameter: just the payable id (u64 LE).
 *  v1 keys payables by global id (F2); the seller is NOT in the parameter.
 *  Proven: pay_ccd p1 message = 0100000000000000, reserve p2 = 0200000000000000. */
export function encodePayableId(payableId) {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(BigInt(payableId));
  return id.toString('hex');
}

/** Encode a v1 confirm_plt parameter: payable id (u64 LE) + tx hash (32B).
 *  Proven: confirm p2 message = 0200000000000000 + 7cc2f94f… (40 bytes). */
export function encodeConfirm({ payableId, txHashHex }) {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(BigInt(payableId));
  return Buffer.concat([id, Buffer.from(txHashHex, 'hex')]).toString('hex');
}
