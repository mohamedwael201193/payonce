// PayOnce API server — parameterized v2 chain access (testnet only).
// Mirrors the backend's src/v2/{registry,send}.mjs, but every call takes
// the registry from config (default v2 <13150,0>) instead of the backend's
// hardcoded REGISTRY_V2 — so the v2.1 switch is a config change.
// Pure parsing still comes from the backend (parsePayableV2 etc.); only
// the contract address + contract name are parameterized here.
// Signers load lazily, in-process only, exactly like backend src/send.mjs
// (keys never leave this process, never logged, never returned).
import {
  AccountAddress,
  ContractAddress,
  TransactionExpiry,
  CcdAmount,
  Energy,
  ReceiveName,
  Parameter,
  SequenceNumber,
  BlockHash,
} from '@concordium/web-sdk';
import { Transaction, Payload } from '@concordium/web-sdk';
import { backend } from './backend.mjs';
import {
  REGISTRY,
  CIS8004_OFFICIAL,
  OWNER_ADDRESS,
  SELLER2_ADDRESS,
  PAYER_ADDRESS,
} from './config.mjs';

export const SELLER = OWNER_ADDRESS;
export const SELLER2 = SELLER2_ADDRESS;
export const PAYER = PAYER_ADDRESS;

let client = null;
export async function grpc() {
  if (!client) {
    const { chain } = await backend();
    client = chain.grpcClient();
  }
  return client;
}

export async function chainNow(c) {
  const { chain } = await backend();
  const consensus = chain.toJson(await c.getConsensusStatus());
  const hash = consensus.lastFinalizedBlock;
  const t = await chain.getBlockTime(c, hash);
  return { blockHash: hash, slotTime: t.slotTime, slotMs: new Date(t.slotTime).getTime() };
}

async function invoke(c, contract, method, paramBuf, blockHashHex = null) {
  const res = await c.invokeContract(
    {
      contract: ContractAddress.create(BigInt(contract.index), BigInt(contract.subindex)),
      method: ReceiveName.fromString(`${REGISTRY.name}.${method}`),
      parameter: Parameter.fromBuffer(paramBuf),
    },
    blockHashHex ? BlockHash.fromHexString(blockHashHex) : undefined,
  );
  return Buffer.from(res.returnValue?.buffer ?? res.returnValue ?? []);
}

const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

export async function getPayable(c, seller, id, blockHashHex = null) {
  const { chain, v2reg, registryV1 } = await backend();
  const param = Buffer.concat([registryV1.accountBytes(seller), u64le(id)]);
  return v2reg.parsePayableV2(await invoke(c, REGISTRY, 'get_payable', param, blockHashHex), seller, id);
}

export async function getPayableOrNull(c, seller, id) {
  try {
    return await getPayable(c, seller, id);
  } catch (e) {
    if (String(e.message).includes('payable view is None')) return null;
    throw e;
  }
}

export async function getConfig(c) {
  const raw = await invoke(c, REGISTRY, 'get_config', Buffer.alloc(0));
  if (raw.length < 24) throw new Error(`v2 config view too short: ${raw.length} bytes`);
  return {
    cis8004: `<${raw.readBigUInt64LE(0)},${raw.readBigUInt64LE(8)}>`,
    reservation_secs: Number(raw.readBigUInt64LE(16)),
  };
}

export async function getVendor(c, buyer, seller, blockHashHex = null) {
  const { v2reg, registryV1 } = await backend();
  const param = Buffer.concat([registryV1.accountBytes(buyer), registryV1.accountBytes(seller)]);
  return v2reg.parseVendorV2(await invoke(c, REGISTRY, 'get_vendor', param, blockHashHex));
}

export async function getUsage(c, buyer, seller, periodIndex, blockHashHex = null) {
  const { registryV1 } = await backend();
  const param = Buffer.concat([registryV1.accountBytes(buyer), registryV1.accountBytes(seller), u64le(periodIndex)]);
  const raw = await invoke(c, REGISTRY, 'get_usage', param, blockHashHex);
  if (raw.length !== 8) throw new Error(`v2 usage view length ${raw.length}, expected 8`);
  return raw.readBigUInt64LE(0).toString();
}

export async function agentOf(c, tokenId) {
  const { v2reg } = await backend();
  const param = Buffer.concat([Buffer.from([8]), u64le(tokenId)]);
  const res = await c.invokeContract({
    contract: ContractAddress.create(BigInt(CIS8004_OFFICIAL.index), BigInt(CIS8004_OFFICIAL.subindex)),
    method: ReceiveName.fromString('CIS-8004.agentOf'),
    parameter: Parameter.fromBuffer(param),
  });
  return v2reg.parseAgentOf(Buffer.from(res.returnValue?.buffer ?? res.returnValue ?? []));
}

export async function getRegistryBalance(c) {
  const info = await c.getInstanceInfo(ContractAddress.create(BigInt(REGISTRY.index), BigInt(REGISTRY.subindex)));
  const j = JSON.parse(JSON.stringify(info, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const amt = j.amount;
  return String(typeof amt === 'object' ? amt.microCcdAmount ?? amt.value ?? amt : amt);
}

export async function getAccount(c, address, blockHashHex = null) {
  const { chain } = await backend();
  if (!blockHashHex) {
    const consensus = chain.toJson(await c.getConsensusStatus());
    blockHashHex = consensus.lastFinalizedBlock;
  }
  return chain.getAccountInfo(c, address, blockHashHex);
}

/** microCCD amount from a toJson'd account-info field (string or object). */
export function microCcdOf(value) {
  if (value == null) return '0';
  if (typeof value === 'object') return String(value.microCcdAmount ?? value.value ?? '0');
  return String(value);
}

export async function getTx(c, hashHex) {
  const { chain } = await backend();
  return chain.getTxStatus(c, hashHex);
}

export async function getBlockTime(c, blockHash) {
  const { chain } = await backend();
  return chain.getBlockTime(c, blockHash);
}

export function canonicalMemoV2(seller, id) {
  return `payable:${seller}:${id}`;
}

// ---- sends (same shapes as the backend's v2/send.mjs, parameterized) ----

let signersCache = null;
/** Load wallet signers in-process (owner + seller B + agent C3 key 0). Never logged. */
export async function signers() {
  if (!signersCache) {
    const { sendMod } = await backend();
    signersCache = sendMod.loadSigners();
  }
  return signersCache;
}

export async function nextNonce(c, address) {
  const { v2send } = await backend();
  return v2send.nextNonce(c, address);
}

export async function waitFinalized(c, txHash, timeoutMs = 120_000) {
  const { v2send } = await backend();
  return v2send.waitFinalized(c, txHash, timeoutMs);
}

export function rejectReasonOf(status) {
  return backend().then(({ v2send }) => v2send.rejectReasonOf(status));
}

/** Retry a send whose transaction the node rejected BEFORE acceptance
 *  for a stale nonce (`duplicate nonce`). Another agent may be sending
 *  from the same account concurrently (the owner's nonce advanced
 *  211 -> 213 in 18 s while the v2.1 worker was deploying): the rejected
 *  tx never entered the mempool, so rebuilding it with a fresh nonce is
 *  safe — it cannot double-send. Bounded (6 attempts, 4 s apart); any
 *  other error throws immediately.
 *  Exported by the main-defect fix (2026-11-25): the helper already
 *  existed here (used by sendUpdate/sendTokenTransfer below) but was not
 *  exported, while b55ae35's receipts.mjs imports it for anchorRecordHash
 *  (fix-back-2 M4) — so server.mjs could not be imported. One-word fix:
 *  export the existing function, semantics unchanged. */
export async function withNonceRetry(fn) {
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // A stale nonce, or a node that answered 429 / UNAVAILABLE BEFORE accepting the tx: nothing
      // was sent, so rebuilding and resubmitting is safe.
      const retriable = /duplicate nonce/i.test(e?.message ?? '') || /RESOURCE_EXHAUSTED|UNAVAILABLE|HTTP status code (429|502|503|504)|ECONNRESET|ETIMEDOUT/i.test(String(e?.message ?? '')) || [8, 14].includes(Number(e?.code));
      if (!retriable) throw e;
      if (attempt === 6) throw e;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  throw lastErr;
}

/** Wait until an account's nonce has been STABLE for `stableMs` (no other
 *  sender is using the account right now). The owner account is shared
 *  with the parallel v2.1 worker, whose sends collide on nonce; a send
 *  issued while the nonce is moving is likely to be rejected as a
 *  duplicate. Bounded by `timeoutMs` — on timeout the caller proceeds
 *  anyway and the duplicate-nonce retry is the backstop. */
async function awaitStableNonce(c, address, { stableMs = 6000, timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastNonce = await nextNonce(c, address);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const n = await nextNonce(c, address);
    if (n !== lastNonce) {
      lastNonce = n;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return lastNonce;
    }
  }
  return lastNonce;
}

export async function sendUpdate(c, { from, receiveName, parameterHex, amountMicroCcd = 0n, maxEnergy = 6000n, expiryMinutes = 5 }) {
  const isContended = from.address === OWNER_ADDRESS;
  return withNonceRetry(async () => {
    // The owner account is shared with the parallel v2.1 worker: wait for
    // a quiet window before building the tx, so the nonce we read is the
    // nonce the node will accept.
    if (isContended) await awaitStableNonce(c, from.address);
    const nonce = await nextNonce(c, from.address);
    const payload = Payload.updateContract({
      amount: CcdAmount.fromMicroCcd(amountMicroCcd),
      address: ContractAddress.create(BigInt(REGISTRY.index), BigInt(REGISTRY.subindex)),
      receiveName: ReceiveName.fromString(`${REGISTRY.name}.${receiveName}`),
      message: Parameter.fromHexString(parameterHex),
    });
    const tx = Transaction.updateContract(payload, Energy.create(maxEnergy)).addMetadata({
      sender: AccountAddress.fromBase58(from.address),
      nonce: SequenceNumber.create(nonce),
      expiry: TransactionExpiry.futureMinutes(expiryMinutes),
    });
    const finalized = await Transaction.signAndFinalize(tx.build(), from.signer);
    const hash = await c.sendTransaction(finalized);
    return { txHash: typeof hash === 'string' ? hash : hash.toString(), nonce };
  });
}

export async function sendTokenTransfer(c, { from, recipient, amount, tokenId = 'EUDemo', memo, expirySeconds }) {
  const { sendMod } = await backend();
  return withNonceRetry(() => sendMod.sendTokenTransfer(c, { from, recipient, amount, tokenId, memo, expirySeconds }));
}

/** The `Updated` summary event for a named receive method, if present. */
export function updatedEvent(status, receiveName) {
  return (status.summary?.events ?? []).find(
    (e) => e.tag === 'Updated' && String(e.address?.index) === String(REGISTRY.index) && e.receiveName === `${REGISTRY.name}.${receiveName}`,
  ) ?? null;
}
