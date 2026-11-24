// PayOnce backend — READ-ONLY probe for the v2 happy-path run.
// Questions: (1) which agent token on the OFFICIAL registry <12802,0> is
// owned by seller B (4MvdMEGC…)? (2) what is the v2 instance state?
// (3) do owner + B hold enough CCD / EUDemo for the run?
// Prints only addresses, token ids and balances — nothing secret.
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { AccountAddress, ContractAddress, ReceiveName, Parameter } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
import { grpcClient, getAccountInfo, tokenBalance, toJson } from '../src/chain.mjs';
import { OWNER_ADDRESS, SELLER_B_ADDRESS, PAYEE2_ADDRESS } from '../src/send.mjs';

const REGISTRY_V2 = ContractAddress.create(13150n, 0n);
const CIS8004 = ContractAddress.create(12802n, 0n);
const PAYEE1_ADDRESS = '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin';

const client = grpcClient();
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const ab = (a) => Buffer.from(AccountAddress.toBuffer(AccountAddress.fromBase58(a)));
const hex = (b) => Buffer.from(b).toString('hex');

// agentOf return layout (lib.rs parse_agent_view, proven live):
// flag(1) + tokenId(9: 0x08 + u64 LE) + owner(32) + opt string + opt hash
// + opt ext-ref + opt address + status(1: 0=Active, 1=Revoked).
function parseAgentOf(buf) {
  if (buf.length === 0 || buf[0] === 0) return null;
  let p = 1;
  const tokenId = buf.readBigUInt64LE(p + 1); p += 9;
  const owner = buf.subarray(p, p + 32); p += 32;
  const optStr = buf[p++]; if (optStr) { const len = buf.readUInt32LE(p); p += 4 + len; }
  const optHash = buf[p++]; if (optHash) p += 32;
  const optExt = buf[p++]; if (optExt) {
    p += 16; const kind = buf[p++]; if (kind !== 0) throw new Error('unexpected ext-ref kind');
    const nsLen = buf.readUInt32LE(p); p += 4 + nsLen;
    const ktLen = buf.readUInt32LE(p); p += 4 + ktLen;
    const pkLen = buf.readUInt32LE(p); p += 4 + pkLen;
  }
  const optAddr = buf[p++]; if (optAddr) p += 32;
  const status = buf[p++];
  return { tokenId: Number(tokenId), ownerHex: hex(owner), status, statusName: status === 0 ? 'Active' : status === 1 ? 'Revoked' : `?${status}`, consumed: p, total: buf.length };
}

const ownerBytes = hex(ab(OWNER_ADDRESS));
const bBytes = hex(ab(SELLER_B_ADDRESS));

// 1. Registry contract name (needed for the invoke method name).
const inst = toJson(await client.getInstanceInfo(CIS8004));
console.log('registry <12802,0> name:', inst.name, '| amount:', inst.amount, '| owner:', inst.owner?.address ?? inst.owner);
// getInstanceInfo returns the INIT name (e.g. init_payable_registry_v2);
// the receive-name contract name is the same string without the init_ prefix
// (matrix-v2.mjs proves payable_registry_v2.* works on <13150,0>).
const stripInit = (n) => n.replace(/^init_/, '');
const regName = stripInit(inst.name);

// 2. agentOf for candidate tokens.
for (const token of [1, 1261, 1476]) {
  const param = Buffer.concat([Buffer.from([8]), u64le(token)]);
  const res = await client.invokeContract({
    contract: CIS8004,
    method: ReceiveName.fromString(`${regName}.agentOf`),
    parameter: Parameter.fromBuffer(param),
  });
  const raw = Buffer.from(res.returnValue?.buffer ?? res.returnValue ?? []);
  const parsed = parseAgentOf(raw);
  if (!parsed) { console.log(`token ${token}: NONE (no such agent)`); continue; }
  const who = parsed.ownerHex === ownerBytes ? 'OWNER' : parsed.ownerHex === bBytes ? 'SELLER B' : 'other';
  console.log(`token ${token}: owner=${who} (${parsed.ownerHex.slice(0, 12)}…) status=${parsed.statusName} bytes=${parsed.consumed}/${parsed.total}`);
}

// 3. v2 config + existing rows (seller=owner ids 1..5, seller=B ids 10,11).
const v2name = stripInit(toJson(await client.getInstanceInfo(REGISTRY_V2)).name);
console.log('v2 <13150,0> name:', v2name);
const view = async (method, param) => {
  const res = await client.invokeContract({ contract: REGISTRY_V2, method: ReceiveName.fromString(`${v2name}.${method}`), parameter: Parameter.fromBuffer(param) });
  return Buffer.from(res.returnValue?.buffer ?? res.returnValue ?? []);
};
const cfg = await view('get_config', Buffer.alloc(0));
console.log('v2 config: cis8004=<', cfg.readBigUInt64LE(0).toString(), ',', cfg.readBigUInt64LE(8).toString(), '> reservation_secs=', Number(cfg.readBigUInt64LE(16)));
const keyParam = (seller, id) => Buffer.concat([ab(seller), u64le(id)]);
for (const [seller, label, ids] of [[OWNER_ADDRESS, 'owner', [1, 2, 3, 4, 5]], [SELLER_B_ADDRESS, 'B', [10, 11]]]) {
  for (const id of ids) {
    const raw = await view('get_payable', keyParam(seller, id));
    if (raw[0] === 0) { console.log(`payable (${label},${id}): absent`); continue; }
    // Minimal parse: status tag is the last field; walk the layout.
    let p = 1 + 32 + 8 + 32 + 8; const assetTag = raw[p++];
    if (assetTag === 1) { const len = raw.readUInt32LE(p); p += 4 + len; }
    p += 8 + 32 + 8; // due + doc_hash + token
    const expFlag = raw[p++]; if (expFlag) p += 32;
    const legFlag = raw[p++]; if (legFlag) p += 32;
    const stTag = raw[p++];
    const stName = ['Unpaid', 'Reserved', 'Paid', 'Voided'][stTag] ?? `?${stTag}`;
    console.log(`payable (${label},${id}): PRESENT status=${stName} len=${raw.length}`);
  }
}
// 4. Vendor row (owner,B) — expect None (matrix revoked it).
const vraw = await view('get_vendor', Buffer.concat([ab(OWNER_ADDRESS), ab(SELLER_B_ADDRESS)]));
console.log('vendor (owner,B):', vraw[0] === 0 ? 'None' : `present len=${vraw.length}`);
// 5. Balances.
for (const [addr, label] of [[OWNER_ADDRESS, 'owner'], [SELLER_B_ADDRESS, 'B'], [PAYEE1_ADDRESS, 'payee1'], [PAYEE2_ADDRESS, 'payee2']]) {
  const info = await getAccountInfo(client, addr);
  console.log(`${label}: ${Number(info.accountAmount.microCcdAmount) / 1e6} CCD nonce=${info.accountNonce} EUDemo=${tokenBalance(info, 'EUDemo')}`);
}
