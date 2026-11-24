// PayOnce backend — v2 contract-logged event decoders.
// Layouts from payable_registry_v2/src/lib.rs ContractEvent (declaration
// order = variant tags). Every variant starts with the tag byte then
// schema_version u8. Validated live by the v2 E2E run (lengths asserted).
//   Registered:     0x00 + ver + seller 32B + id u64 + payee 32B + amount u64
//                   + asset + due u64 ms + doc_hash 32B + expected opt + legal opt
//   VendorApproved: 0x01 + ver + buyer 32B + seller 32B + tier u8 + legal opt
//                   + perCap u64 + periodCap u64 + periodSecs u64
//   Reserved:       0x04 + ver + seller 32B + id u64 + payer 32B + expires u64 ms
//   Paid:           0x06 + ver + seller 32B + id u64 + payer 32B + amount u64 + asset
//   PltConfirmed:   0x07 + ver + seller 32B + id u64 + payer 32B + tx_hash 32B
//                   + reservation_expires u64 ms
import { accountFromBytes } from '../registry.mjs';

function u64le(buf, off) {
  return buf.readBigUInt64LE(off).toString();
}

export function decodeContractEventV2(hex) {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length < 2) throw new Error('empty v2 contract event');
  const tag = buf[0];
  const version = buf[1];
  let p = 2;
  const seller = () => { const a = accountFromBytes(buf.subarray(p, p + 32)); p += 32; return a; };
  const id = () => { const v = Number(buf.readBigUInt64LE(p)); p += 8; return v; };
  const asset = () => {
    const t = buf[p++];
    if (t === 0) return 'CCD';
    const len = buf.readUInt32LE(p); p += 4;
    const s = buf.subarray(p, p + len).toString('utf8'); p += len;
    return s;
  };
  const optAddr = () => {
    const f = buf[p++];
    if (!f) return null;
    const a = accountFromBytes(buf.subarray(p, p + 32)); p += 32;
    return a;
  };
  const optHash = () => {
    const f = buf[p++];
    if (!f) return null;
    const h = buf.subarray(p, p + 32).toString('hex'); p += 32;
    return h;
  };
  if (tag === 0x00) {
    const s = seller(); const i = id(); const payee = accountFromBytes(buf.subarray(p, p + 32)); p += 32;
    const amount = u64le(buf, p); p += 8;
    const a = asset();
    const dueMs = u64le(buf, p); p += 8;
    const docHash = buf.subarray(p, p + 32).toString('hex'); p += 32;
    const expected = optAddr(); const legal = optHash();
    if (p !== buf.length) throw new Error(`Registered event trailing bytes: ${buf.length - p}`);
    return { event: 'Registered', schemaVersion: version, seller: s, payableId: i, payee, amount, asset: a, dueMs, docHash, expectedPayer: expected, legalRef: legal };
  }
  if (tag === 0x01) {
    const buyer = accountFromBytes(buf.subarray(p, p + 32)); p += 32;
    const s = seller(); const tier = buf[p++];
    const legal = optHash();
    const perCap = u64le(buf, p); p += 8;
    const periodCap = u64le(buf, p); p += 8;
    const periodSecs = u64le(buf, p); p += 8;
    if (p !== buf.length) throw new Error(`VendorApproved event trailing bytes: ${buf.length - p}`);
    return { event: 'VendorApproved', schemaVersion: version, buyer, seller: s, tier, legalRef: legal, perPayableCap: perCap, periodCap, periodSecs };
  }
  if (tag === 0x04) {
    const s = seller(); const i = id();
    const payer = accountFromBytes(buf.subarray(p, p + 32)); p += 32;
    const expiresMs = u64le(buf, p); p += 8;
    if (p !== buf.length) throw new Error(`Reserved event trailing bytes: ${buf.length - p}`);
    return { event: 'Reserved', schemaVersion: version, seller: s, payableId: i, payer, expiresMs, expires: new Date(Number(expiresMs)).toISOString() };
  }
  if (tag === 0x06) {
    const s = seller(); const i = id();
    const payer = accountFromBytes(buf.subarray(p, p + 32)); p += 32;
    const amount = u64le(buf, p); p += 8;
    const a = asset();
    if (p !== buf.length) throw new Error(`Paid event trailing bytes: ${buf.length - p}`);
    return { event: 'Paid', schemaVersion: version, seller: s, payableId: i, payer, amount, asset: a };
  }
  if (tag === 0x07) {
    const s = seller(); const i = id();
    const payer = accountFromBytes(buf.subarray(p, p + 32)); p += 32;
    const txHash = buf.subarray(p, p + 32).toString('hex'); p += 32;
    const reservationExpiresMs = u64le(buf, p); p += 8;
    if (p !== buf.length) throw new Error(`PltConfirmed event trailing bytes: ${buf.length - p}`);
    return { event: 'PltConfirmed', schemaVersion: version, seller: s, payableId: i, payer, txHash, reservationExpiresMs, reservationExpires: new Date(Number(reservationExpiresMs)).toISOString() };
  }
  throw new Error(`unknown v2 contract event tag 0x${tag.toString(16)} (len ${buf.length})`);
}

/** All decoded v2 contract-logged events from an `Updated` summary event. */
export function decodeLoggedEventsV2(updatedEvent) {
  const out = [];
  for (const hex of updatedEvent?.events ?? []) {
    try {
      out.push(decodeContractEventV2(hex));
    } catch (e) {
      out.push({ event: 'Unknown', raw: hex, error: e.message });
    }
  }
  return out;
}
