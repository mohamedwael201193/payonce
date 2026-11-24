// PayOnce backend — shared chain access (testnet only, read-only unless a
// caller explicitly passes a signer; no keys are read or stored here).
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { TransactionHash, BlockHash, ContractAddress, AccountAddress } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';

export const GRPC_HOST = 'grpc.testnet.concordium.com';
export const GRPC_PORT = 20000;
export const REGISTRY_V1 = { index: 13149n, subindex: 0n };
export const CIS8004_LAB = { index: 13144n, subindex: 0n };
export const CIS8004_OFFICIAL = { index: 12802n, subindex: 0n };
export const EUDEMO_DECIMALS = 6;

export function grpcClient() {
  return new ConcordiumGRPCNodeClient(GRPC_HOST, GRPC_PORT, credentials.createSsl());
}

export const toJson = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)));

/** Finalized status + summary for a tx hash. Throws if the tx is not found. */
export async function getTxStatus(client, hashHex) {
  const s = await client.getBlockItemStatus(TransactionHash.fromHexString(hashHex));
  const j = toJson(s);
  if (!j.outcome) throw new Error(`no outcome for tx ${hashHex}`);
  return { status: j.status, blockHash: j.outcome.blockHash, summary: j.outcome.summary };
}

/** Block slot time (ISO) + height for a block hash. */
export async function getBlockTime(client, blockHashHex) {
  const info = await client.getBlockInfo(BlockHash.fromHexString(blockHashHex));
  const j = toJson(info);
  return { slotTime: j.blockSlotTime, height: j.blockHeight };
}

/** Slot time of the block that contains a tx. */
export async function getTxBlockTime(client, hashHex) {
  const { blockHash } = await getTxStatus(client, hashHex);
  return getBlockTime(client, blockHash);
}

/** Account info at a finalized block (nonce, balances, protocol-level tokens). */
export async function getAccountInfo(client, address, blockHash) {
  const info = await client.getAccountInfo(AccountAddress.fromBase58(address), BlockHash.fromHexString(blockHash));
  return toJson(info);
}

/** Balance of a protocol-level token (e.g. EUDemo) held by an account, as a string of base units. */
export function tokenBalance(accountInfoJson, tokenId) {
  const tokens = accountInfoJson?.accountTokens ?? accountInfoJson?.tokens ?? [];
  for (const t of tokens) {
    const id = t.tokenId ?? t.id ?? t.token_id;
    if (String(id) === tokenId) {
      const b = t.amount ?? t.balance ?? t.state?.balance ?? '0';
      return String(typeof b === 'object' ? b.value ?? '0' : b);
    }
  }
  return '0';
}

export function u64le(buf, off) {
  return buf.readBigUInt64LE(off);
}

/** Decode a CBOR text-string memo as returned by the node (hex -> text).
 *  PLT memos are CBOR values (the SDK requires CborMemo.fromString()).
 *  A canonical memo is exactly the CBOR text encoding of the string:
 *  header 0x60+len (len < 24), 0x78+len (len < 256), or 0x79+len (u16).
 *  Returns { text, canonical } where canonical means the bytes are exactly
 *  the shortest CBOR encoding of the decoded text. */
export function decodeCborMemo(memoHex) {
  const bytes = Buffer.from(memoHex ?? '', 'hex');
  if (bytes.length === 0) return { text: '', canonical: false };
  const b0 = bytes[0];
  if ((b0 & 0xe0) !== 0x60) return { text: '', canonical: false };
  let len;
  let headerLen;
  const ai = b0 & 0x1f;
  if (ai < 24) {
    len = ai;
    headerLen = 1;
  } else if (ai === 24) {
    if (bytes.length < 2) return { text: '', canonical: false };
    len = bytes[1];
    headerLen = 2;
  } else if (ai === 25) {
    if (bytes.length < 3) return { text: '', canonical: false };
    len = bytes.readUInt16BE(1);
    headerLen = 3;
  } else {
    return { text: '', canonical: false };
  }
  if (bytes.length !== headerLen + len) return { text: '', canonical: false };
  const text = bytes.subarray(headerLen).toString('utf8');
  const canonical = encodeCborMemo(text).equals(bytes);
  return { text, canonical };
}

/** Canonical CBOR text encoding of a string (shortest form). */
export function encodeCborMemo(text) {
  const body = Buffer.from(text, 'utf8');
  if (body.length < 24) return Buffer.concat([Buffer.from([0x60 + body.length]), body]);
  if (body.length < 256) return Buffer.concat([Buffer.from([0x78, body.length]), body]);
  const header = Buffer.alloc(3);
  header[0] = 0x79;
  header.writeUInt16BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/** Legacy helper kept for plain (non-CBOR) memos. */
export function memoHexToString(memoHex) {
  return Buffer.from(memoHex, 'hex').toString('utf8');
}

/** Canonical v1 memo: `payable:<id>`. v2 memo: `payable:<seller>:<id>`. */
export function canonicalMemo(key) {
  return key.seller ? `payable:${key.seller}:${key.id}` : `payable:${key.id}`;
}

/** The contract-logged event bytes (hex) inside an `Updated` summary event. */
export function contractLoggedEvents(summaryEvent) {
  if (summaryEvent?.tag !== 'Updated' || !Array.isArray(summaryEvent.events)) return [];
  return summaryEvent.events;
}

/** Find the `Updated` event for a given contract + receiveName in a summary. */
export function findUpdated(summary, contractIndex, receiveName) {
  return (summary.events ?? []).find(
    (e) => e.tag === 'Updated' && String(e.address?.index) === String(contractIndex) && e.receiveName === receiveName,
  );
}
