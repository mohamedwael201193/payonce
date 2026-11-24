// PayOnce backend — v2 parameter encoders (concordium-std Serial, LE).
// Layouts proven live by the contract matrix (scripts/matrix-v2.mjs):
// register_payable = id u64 + payee 32B + amount u64 + asset
//   (0x00 CCD / 0x01 + u32 len + symbol) + due u64 ms + doc_hash 32B +
//   agent_token u64 + expected_payer Option<AccountAddress> +
//   legal_ref Option<[u8;32]>.
// pay_ccd / reserve_plt / expire_reservation = PayableKeyParam:
//   seller 32B + id u64. confirm_plt = seller 32B + id u64 + tx_hash 32B.
// approve_vendor = seller 32B + tier u8 + legal Option + perCap u64 +
//   periodCap u64 + periodSecs u64. void_payable = id u64 only.
import { accountBytes } from '../registry.mjs';

const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const optAddr = (a) => (a ? Buffer.concat([Buffer.from([1]), accountBytes(a)]) : Buffer.from([0]));
const optHash = (h) => (h ? Buffer.concat([Buffer.from([1]), Buffer.from(h, 'hex')]) : Buffer.from([0]));

function assetBytes(asset) {
  if (asset === 'CCD') return Buffer.from([0]);
  const sym = Buffer.from(asset, 'utf8');
  return Buffer.concat([Buffer.from([1]), u32le(sym.length), sym]);
}

export function encodeV2RegisterPayable({ id, payee, amount, asset, dueMs, docHashHex, token, expected = null, legal = null }) {
  return Buffer.concat([
    u64le(id),
    accountBytes(payee),
    u64le(amount),
    assetBytes(asset),
    u64le(dueMs),
    Buffer.from(docHashHex, 'hex'),
    u64le(token),
    optAddr(expected),
    optHash(legal),
  ]).toString('hex');
}

export function encodeV2PayableKey({ seller, id }) {
  return Buffer.concat([accountBytes(seller), u64le(id)]).toString('hex');
}

export function encodeV2Confirm({ seller, id, txHashHex }) {
  return Buffer.concat([accountBytes(seller), u64le(id), Buffer.from(txHashHex, 'hex')]).toString('hex');
}

export function encodeV2ApproveVendor({ seller, tier, legal = null, perCap, periodCap, periodSecs }) {
  return Buffer.concat([
    accountBytes(seller),
    Buffer.from([tier]),
    optHash(legal),
    u64le(perCap),
    u64le(periodCap),
    u64le(periodSecs),
  ]).toString('hex');
}

export function encodeV2Void({ id }) {
  return u64le(id).toString('hex');
}

export function encodeV2SetStrict(strict) {
  return Buffer.from([strict ? 1 : 0]).toString('hex');
}
