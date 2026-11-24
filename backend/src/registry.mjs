// PayOnce backend — payable registry views (v1 layout, structurally decoded
// and validated live; see spikes/view-layout.mjs).
//
// v1 `get_payable` return layout (offsets validated against payables 1-4):
//   [0]     0x01                 Option<Payable> = Some
//   [1..9)  payable_id           u64 LE
//   [9..41) seller               AccountAddress (32 bytes)
//   [41..73) payee               AccountAddress (32 bytes)
//   [73..81) amount              u64 LE (microCCD, or PLT base units)
//   [81]    asset tag: 0x00 = CCD (no symbol bytes follow);
//           0x01 = PLT, followed by u32 LE symbol length + symbol bytes
//           (e.g. "EUDemo").
//   [..]    due                  u64 LE, milliseconds since epoch
//   [+32]   doc_hash             32 bytes (SHA-256 of the invoice document)
//   [+16]   agent_registry       ContractAddress: index u64 LE + subindex u64 LE
//           (v1 payables point at the lab CIS-8004 <13144,0>)
//   [+4]    u32 LE 8             (token-id length prefix)
//   [+8]    agent token id       u64 LE (length-prefixed TokenId, 8 bytes)
//   [+1]    status: 0x00 Unpaid, 0x01 Reserved, 0x02 Paid
//   Payment record, present only when status == Paid:
//   [+32]   payer                AccountAddress (32 bytes)
//   [+8]    paid_at              u64 LE ms (== payment/confirm block slot time)
//   [+1]    tx_hash option: 0x00 = None (CCD rail), 0x01 + 32 bytes = Some (PLT)
//   When Reserved (unconfirmed shape): payer 32B + expires u64 LE ms.
//   When Unpaid: the view ends right after the status byte.
// S5 note: the v1 module carries NO embedded schema (getEmbeddedModuleSchema
// returns undefined), so schema-decoding is impossible for v1; this
// structural decode is validated three ways (parameter vs event vs view vs
// Transferred/TokenTransfer event). v2 MUST embed its schema (requirement
// to the contract agent).
import { ContractAddress, ReceiveName, Parameter, AccountAddress, BlockHash } from '@concordium/web-sdk';
import { REGISTRY_V1 } from './chain.mjs';

export function accountBytes(addressBase58) {
  return Buffer.from(AccountAddress.toBuffer(AccountAddress.fromBase58(addressBase58)));
}

export function accountFromBytes(buf) {
  return AccountAddress.fromBuffer(buf).toString();
}

/** Parse a v1 get_payable return buffer. Throws on a malformed layout. */
export function parsePayableView(buf, expectedId) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  // A 1-byte 0x00 buffer IS the None view (unregistered payable) — check
  // it before the length check so callers can distinguish it.
  if (buf.length === 1 && buf[0] === 0x00) throw new Error('payable view is None (byte 0 = 0)');
  // Unpaid view is exactly 151 bytes (1 + 8 + 32 + 32 + 8 + 1 + 8 + 32 + 16 + 4 + 8 + 1).
  // Paid adds 41–73 bytes, Reserved adds 40. (The old 161 minimum was wrong
  // and only ever passed because every view parsed live so far was Paid.)
  if (buf.length < 151) throw new Error(`payable view too short: ${buf.length} bytes`);
  if (buf[0] !== 0x01) throw new Error(`payable view is None (byte 0 = ${buf[0]})`);
  const id = Number(buf.readBigUInt64LE(1));
  if (expectedId !== undefined && id !== expectedId) {
    throw new Error(`payable view id mismatch: view has ${id}, expected ${expectedId}`);
  }
  const seller = accountFromBytes(buf.subarray(9, 41));
  const payee = accountFromBytes(buf.subarray(41, 73));
  const amount = buf.readBigUInt64LE(73);
  let off = 81;
  let asset = 'CCD';
  const assetTag = buf[off];
  off += 1;
  if (assetTag === 0x01) {
    // PLT: u32 LE symbol length + symbol bytes.
    const symLen = buf.readUInt32LE(off);
    off += 4;
    if (symLen < 1 || symLen > 64) throw new Error(`implausible PLT symbol length ${symLen}`);
    asset = buf.subarray(off, off + symLen).toString('utf8');
    if (!/^[A-Za-z0-9]{1,64}$/.test(asset)) throw new Error(`implausible PLT symbol ${JSON.stringify(asset)}`);
    off += symLen;
  } else if (assetTag !== 0x00) {
    throw new Error(`unexpected asset tag byte ${assetTag} at offset 81`);
  }
  const dueMs = buf.readBigUInt64LE(off);
  off += 8;
  const docHash = buf.subarray(off, off + 32).toString('hex');
  off += 32;
  // agent_registry: ContractAddress = index u64 LE + subindex u64 LE.
  const registryIndex = buf.readBigUInt64LE(off);
  const registrySubindex = buf.readBigUInt64LE(off + 8);
  off += 16;
  const tokenLen = buf.readUInt32LE(off);
  off += 4;
  if (tokenLen !== 8) throw new Error(`unexpected agent token length ${tokenLen}`);
  const agentToken = buf.readBigUInt64LE(off);
  off += 8;
  // Status byte: 0x00 Unpaid, 0x01 Reserved, 0x02 Paid (0x01 unconfirmed —
  // no live Reserved payable exists in v1 to validate against).
  const statusByte = buf[off];
  off += 1;
  const status = statusByte === 0x02 ? 'Paid' : statusByte === 0x01 ? 'Reserved' : statusByte === 0x00 ? 'Unpaid' : 'Unknown';
  if (status === 'Unknown') throw new Error(`unexpected status byte 0x${statusByte.toString(16)}`);
  // Payment record (only when Paid).
  let record = null;
  if (status === 'Paid') {
    const payer = accountFromBytes(buf.subarray(off, off + 32));
    off += 32;
    const paidAtMs = buf.readBigUInt64LE(off);
    off += 8;
    const txOpt = buf[off];
    off += 1;
    let txHash = null;
    if (txOpt === 0x01) {
      txHash = buf.subarray(off, off + 32).toString('hex');
      off += 32;
    } else if (txOpt !== 0x00) {
      throw new Error(`unexpected tx_hash option byte ${txOpt}`);
    }
    if (off !== buf.length) throw new Error(`trailing bytes in payable view: ${buf.length - off}`);
    record = { payer, paidAtMs: paidAtMs.toString(), paidAt: new Date(Number(paidAtMs)).toISOString(), txHash };
  } else if (status === 'Reserved') {
    // Reserved record shape is unconfirmed (no live Reserved payable in v1):
    // expect payer (32B) + expires (8B); anything else is fail-closed.
    if (buf.length - off !== 40) throw new Error(`Reserved view has unexpected tail length ${buf.length - off}`);
    const payer = accountFromBytes(buf.subarray(off, off + 32));
    off += 32;
    const expiresMs = buf.readBigUInt64LE(off);
    off += 8;
    record = { payer, expiresMs: expiresMs.toString(), expires: new Date(Number(expiresMs)).toISOString(), txHash: null };
  } else if (off !== buf.length) {
    throw new Error(`trailing bytes in Unpaid payable view: ${buf.length - off}`);
  }
  return {
    id,
    seller,
    payee,
    amount: amount.toString(),
    asset,
    dueMs: dueMs.toString(),
    due: new Date(Number(dueMs)).toISOString(),
    docHash,
    agentRegistry: { index: registryIndex.toString(), subindex: registrySubindex.toString() },
    agentToken: agentToken.toString(),
    status,
    record,
  };
}

/** Live get_payable view for a v1 payable id. blockHashHex (optional) pins the read to that finalized block. */
export async function getPayable(client, id, contract = REGISTRY_V1, blockHashHex = null) {
  const param = Number(id).toString(16).padStart(2, '0') + '00000000000000';
  const r = await client.invokeContract({
    contract: ContractAddress.create(contract.index, contract.subindex),
    method: ReceiveName.fromString('payable_registry.get_payable'),
    parameter: Parameter.fromHexString(param),
  }, blockHashHex ? BlockHash.fromHexString(blockHashHex) : undefined);
  return parsePayableView(Buffer.from(r.returnValue.buffer), Number(id));
}

/** getPayable, but null when the payable is unregistered (view = None). */
export async function getPayableOrNull(client, id, contract = REGISTRY_V1) {
  try {
    return await getPayable(client, id, contract);
  } catch (e) {
    if (String(e.message).includes('payable view is None')) return null;
    throw e;
  }
}

/** Live instance balance (microCCD) — the zero-balance invariant check. */
export async function getRegistryBalance(client, contract = REGISTRY_V1) {
  const info = await client.getInstanceInfo(ContractAddress.create(contract.index, contract.subindex));
  const j = JSON.parse(JSON.stringify(info, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return j.amount;
}
