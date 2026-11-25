// PayOnce backend — v2 registry views + encoders' shared constants.
// Contract <13150,0> (payable_registry_v2), official CIS-8004 <12802,0>.
// This module is SEPARATE from the v1 registry module: the v1 run
// (src/registry.mjs, REGISTRY <13149,0>) stays untouched.
// View layout proven live by the contract matrix (matrix-v2.mjs) and by the
// judge's independent parse (payables 133 B CCD / 175 B with expected payer /
// 141 B Voided). Do NOT improvise layouts — read lib.rs if in doubt.
import { ContractAddress, ReceiveName, Parameter, BlockHash } from '@concordium/web-sdk';
import { accountFromBytes, accountBytes } from '../registry.mjs';

export const REGISTRY_V2 = { index: 13150n, subindex: 0n };
export const CONTRACT_NAME_V2 = 'payable_registry_v2';
export const REGISTRY_V2_1 = { index: 13152n, subindex: 0n };
export const CONTRACT_NAME_V2_1 = 'payable_registry_v2_1';
export const CIS8004_OFFICIAL = { index: 12802n, subindex: 0n };
export const OWNER_TOKEN_V2 = 1476; // deployer's agent token on <12802,0>, Active (probed live)
export const SELLER2_TOKEN_V2 = 1506; // second seller's agent token on <12802,0>, Active (live 2026-11-25)
export const RESERVATION_SECS_V2 = 3600;

// contract/contractName default to the v2 registry: every existing caller
// reads <13150,0> unchanged. v2.1 (<13152,0> payable_registry_v2_1) shares
// the v2 view layout (same shapes as v2 — G7 verifier fix), so a v2.1
// view is read by passing REGISTRY_V2_1 / CONTRACT_NAME_V2_1.
async function invokeView(client, method, paramBuf, blockHashHex = null, contract = REGISTRY_V2, contractName = CONTRACT_NAME_V2) {
  const res = await client.invokeContract(
    {
      contract: ContractAddress.create(contract.index, contract.subindex),
      method: ReceiveName.fromString(`${contractName}.${method}`),
      parameter: Parameter.fromBuffer(paramBuf),
    },
    blockHashHex ? BlockHash.fromHexString(blockHashHex) : undefined,
  );
  return Buffer.from(res.returnValue?.buffer ?? res.returnValue ?? []);
}

/** Parse a v2 get_payable return buffer. Layout (matrix parsePayable):
 * [0] Some flag; seller 32B; id u64; payee 32B; amount u64; asset tag
 * (0x00 CCD / 0x01 + u32 len + symbol); due u64 ms; doc_hash 32B;
 * token u64; expected Option<AccountAddress>; legal Option<[u8;32]>;
 * status tag: 0 Unpaid, 1 Reserved (payer 32B + reserved_at u64 + expires u64),
 * 2 Paid (payer 32B + reservation_expires Option<u64> + paid_at u64 +
 * tx_hash Option<32B>), 3 Voided (voided_at u64). Throws on malformed layout. */
export function parsePayableV2(buf, seller, expectedId) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length === 1 && buf[0] === 0x00) throw new Error('payable view is None (byte 0 = 0)');
  if (buf.length < 133) throw new Error(`v2 payable view too short: ${buf.length} bytes`);
  if (buf[0] !== 0x01) throw new Error(`v2 payable view is None (byte 0 = ${buf[0]})`);
  let p = 1;
  const sellerAddr = accountFromBytes(buf.subarray(p, p + 32)); p += 32;
  const id = Number(buf.readBigUInt64LE(p)); p += 8;
  if (seller !== undefined && sellerAddr !== seller) throw new Error(`v2 payable view seller mismatch: ${sellerAddr} != ${seller}`);
  if (expectedId !== undefined && id !== expectedId) throw new Error(`v2 payable view id mismatch: ${id} != ${expectedId}`);
  const payee = accountFromBytes(buf.subarray(p, p + 32)); p += 32;
  const amount = buf.readBigUInt64LE(p); p += 8;
  const assetTag = buf[p++];
  let asset = 'CCD';
  if (assetTag === 0x01) {
    const len = buf.readUInt32LE(p); p += 4;
    if (len < 1 || len > 64) throw new Error(`implausible PLT symbol length ${len}`);
    asset = buf.subarray(p, p + len).toString('utf8'); p += len;
  } else if (assetTag !== 0x00) {
    throw new Error(`unexpected asset tag byte ${assetTag}`);
  }
  const dueMs = buf.readBigUInt64LE(p); p += 8;
  const docHash = buf.subarray(p, p + 32).toString('hex'); p += 32;
  const token = buf.readBigUInt64LE(p); p += 8;
  const expFlag = buf[p++];
  const expectedPayer = expFlag ? accountFromBytes(buf.subarray(p, p + 32)) : null;
  if (expFlag) p += 32;
  const legFlag = buf[p++];
  const legalRef = legFlag ? buf.subarray(p, p + 32).toString('hex') : null;
  if (legFlag) p += 32;
  const stTag = buf[p++];
  const status = stTag === 0 ? 'Unpaid' : stTag === 1 ? 'Reserved' : stTag === 2 ? 'Paid' : stTag === 3 ? 'Voided' : 'Unknown';
  if (status === 'Unknown') throw new Error(`unexpected v2 status byte 0x${stTag.toString(16)}`);
  let record = null;
  if (status === 'Reserved') {
    const payer = accountFromBytes(buf.subarray(p, p + 32)); p += 32;
    const reservedAtMs = buf.readBigUInt64LE(p); p += 8;
    const expiresMs = buf.readBigUInt64LE(p); p += 8;
    record = {
      payer,
      reservedAtMs: reservedAtMs.toString(),
      reservedAt: new Date(Number(reservedAtMs)).toISOString(),
      expiresMs: expiresMs.toString(),
      expires: new Date(Number(expiresMs)).toISOString(),
    };
  } else if (status === 'Paid') {
    const payer = accountFromBytes(buf.subarray(p, p + 32)); p += 32;
    const reFlag = buf[p++];
    const reservationExpiresMs = reFlag ? buf.readBigUInt64LE(p) : null;
    if (reFlag) p += 8;
    const paidAtMs = buf.readBigUInt64LE(p); p += 8;
    const txFlag = buf[p++];
    const txHash = txFlag ? buf.subarray(p, p + 32).toString('hex') : null;
    if (txFlag) p += 32;
    record = {
      payer,
      reservationExpiresMs: reservationExpiresMs === null ? null : reservationExpiresMs.toString(),
      reservationExpires: reservationExpiresMs === null ? null : new Date(Number(reservationExpiresMs)).toISOString(),
      paidAtMs: paidAtMs.toString(),
      paidAt: new Date(Number(paidAtMs)).toISOString(),
      txHash,
    };
  } else if (status === 'Voided') {
    const voidedAtMs = buf.readBigUInt64LE(p); p += 8;
    record = { voidedAtMs: voidedAtMs.toString(), voidedAt: new Date(Number(voidedAtMs)).toISOString() };
  }
  if (p !== buf.length) throw new Error(`trailing bytes in v2 payable view: ${buf.length - p}`);
  return {
    seller: sellerAddr,
    id,
    payee,
    amount: amount.toString(),
    asset,
    dueMs: dueMs.toString(),
    due: new Date(Number(dueMs)).toISOString(),
    docHash,
    agentToken: token.toString(),
    expectedPayer,
    legalRef,
    status,
    record,
  };
}

/** get_payable view for a v2 (seller, id) key. blockHashHex pins the read.
 * contract/contractName select the registry (default v2 <13150,0>);
 * pass REGISTRY_V2_1 / CONTRACT_NAME_V2_1 for a v2.1 view. */
export async function getPayableV2(client, seller, id, blockHashHex = null, contract = REGISTRY_V2, contractName = CONTRACT_NAME_V2) {
  const param = Buffer.concat([accountBytes(seller), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(id)); return b; })()]);
  return parsePayableV2(await invokeView(client, 'get_payable', param, blockHashHex, contract, contractName), seller, id);
}

/** getPayableV2, but null when the payable is unregistered (view = None). */
export async function getPayableV2OrNull(client, seller, id, contract = REGISTRY_V2, contractName = CONTRACT_NAME_V2) {
  try {
    return await getPayableV2(client, seller, id, null, contract, contractName);
  } catch (e) {
    if (String(e.message).includes('payable view is None')) return null;
    throw e;
  }
}

/** get_config view: { cis8004: '<index,subindex>', reservation_secs }. */
export async function getConfigV2(client) {
  const raw = await invokeView(client, 'get_config', Buffer.alloc(0));
  if (raw.length < 24) throw new Error(`v2 config view too short: ${raw.length} bytes`);
  return {
    cis8004: `<${raw.readBigUInt64LE(0)},${raw.readBigUInt64LE(8)}>`,
    reservation_secs: Number(raw.readBigUInt64LE(16)),
  };
}

/** Parse a v2 get_vendor return: null (None) or the approval row. */
export function parseVendorV2(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length === 1 && buf[0] === 0x00) return null;
  if (buf[0] !== 0x01) throw new Error(`v2 vendor view flag ${buf[0]}`);
  let p = 1;
  const tier = buf[p++];
  const legFlag = buf[p++];
  const legalRef = legFlag ? buf.subarray(p, p + 32).toString('hex') : null;
  if (legFlag) p += 32;
  const perPayableCap = buf.readBigUInt64LE(p); p += 8;
  const periodCap = buf.readBigUInt64LE(p); p += 8;
  const periodSecs = buf.readBigUInt64LE(p); p += 8;
  if (p !== buf.length) throw new Error(`trailing bytes in v2 vendor view: ${buf.length - p}`);
  return {
    tier,
    legalRef,
    perPayableCap: perPayableCap.toString(),
    periodCap: periodCap.toString(),
    periodSecs: periodSecs.toString(),
  };
}

/** get_vendor view for a (buyer, seller) pair. */
export async function getVendorV2(client, buyer, seller, blockHashHex = null) {
  const param = Buffer.concat([accountBytes(buyer), accountBytes(seller)]);
  return parseVendorV2(await invokeView(client, 'get_vendor', param, blockHashHex));
}

/** get_usage view: spent base units in the period (u64 LE). */
export async function getUsageV2(client, buyer, seller, periodIndex, blockHashHex = null) {
  const idx = Buffer.alloc(8);
  idx.writeBigUInt64LE(BigInt(periodIndex));
  const param = Buffer.concat([accountBytes(buyer), accountBytes(seller), idx]);
  const raw = await invokeView(client, 'get_usage', param, blockHashHex);
  if (raw.length !== 8) throw new Error(`v2 usage view length ${raw.length}, expected 8`);
  return raw.readBigUInt64LE(0).toString();
}

/** Parse a CIS-8004 agentOf return into { owner, status, statusName }.
 * Layout (lib.rs parse_agent_view): flag + token(9B) + owner(32B) +
 * opt string + opt hash + opt ext-ref + opt address + status u8.
 * NOTE: the live return carries trailing bytes after the status byte
 * (e.g. token 1476: 93 bytes, 79 consumed) — the contract's own reader
 * also stops at status, so trailing bytes are ignored here too. */
export function parseAgentOf(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length === 0 || buf[0] === 0) return null;
  let p = 1;
  p += 9; // token id (0x08 + u64 LE)
  const owner = accountFromBytes(buf.subarray(p, p + 32)); p += 32;
  const optStr = buf[p++]; if (optStr) { const len = buf.readUInt32LE(p); p += 4 + len; }
  const optHash = buf[p++]; if (optHash) p += 32;
  const optExt = buf[p++]; if (optExt) {
    p += 16;
    const kind = buf[p++]; if (kind !== 0) throw new Error('unexpected ext-ref kind');
    const nsLen = buf.readUInt32LE(p); p += 4 + nsLen;
    const ktLen = buf.readUInt32LE(p); p += 4 + ktLen;
    const pkLen = buf.readUInt32LE(p); p += 4 + pkLen;
  }
  const optAddr = buf[p++]; if (optAddr) p += 32;
  const status = buf[p++];
  return { owner, status, statusName: status === 0 ? 'Active' : status === 1 ? 'Revoked' : `unknown(${status})` };
}

/** agentOf view on the OFFICIAL registry <12802,0>. */
export async function agentOf(client, tokenId) {
  const param = Buffer.concat([Buffer.from([8]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(tokenId)); return b; })()]);
  const res = await client.invokeContract({
    contract: ContractAddress.create(CIS8004_OFFICIAL.index, CIS8004_OFFICIAL.subindex),
    method: ReceiveName.fromString('CIS-8004.agentOf'),
    parameter: Parameter.fromBuffer(param),
  });
  return parseAgentOf(Buffer.from(res.returnValue?.buffer ?? res.returnValue ?? []));
}

/** Live instance balance (microCCD string) — the zero-balance invariant. */
export async function getRegistryBalanceV2(client, contract = REGISTRY_V2) {
  const info = await client.getInstanceInfo(ContractAddress.create(contract.index, contract.subindex));
  const j = JSON.parse(JSON.stringify(info, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const amt = j.amount;
  return String(typeof amt === 'object' ? amt.microCcdAmount ?? amt.value ?? amt : amt);
}
