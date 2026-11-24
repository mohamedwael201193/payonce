// PayOnce backend — contract-logged event decoders (v1).
// Layouts validated live against the v1 txs (spikes/s5-s6.mjs,
// spikes/reserve-confirm-probe.mjs):
//   Registered:   0x00 + payable_id u64 LE + seller 32B + payee 32B + amount u64 LE (81 B)
//   Paid:         0x01 + payable_id u64 LE + payer 32B + amount u64 LE (49 B)
//   Reserved:     0x02 + payable_id u64 LE + payer 32B + expires u64 LE ms (49 B)
//   PltConfirmed: 0x03 + payable_id u64 LE + payer 32B + tx_hash 32B (73 B)
import { accountFromBytes } from './registry.mjs';

function u64le(buf, off) {
  return buf.readBigUInt64LE(off).toString();
}

export function decodeContractEvent(hex) {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length < 1) throw new Error('empty contract event');
  const tag = buf[0];
  const id = Number(buf.readBigUInt64LE(1));
  if (tag === 0x00) {
    if (buf.length !== 81) throw new Error(`Registered event wrong length: ${buf.length}`);
    return {
      event: 'Registered',
      payableId: id,
      seller: accountFromBytes(buf.subarray(9, 41)),
      payee: accountFromBytes(buf.subarray(41, 73)),
      amount: u64le(buf, 73),
    };
  }
  if (tag === 0x01) {
    if (buf.length !== 49) throw new Error(`Paid event wrong length: ${buf.length}`);
    return {
      event: 'Paid',
      payableId: id,
      payer: accountFromBytes(buf.subarray(9, 41)),
      amount: u64le(buf, 41),
    };
  }
  if (tag === 0x02) {
    if (buf.length !== 49) throw new Error(`Reserved event wrong length: ${buf.length}`);
    return {
      event: 'Reserved',
      payableId: id,
      payer: accountFromBytes(buf.subarray(9, 41)),
      expiresMs: u64le(buf, 41),
      expires: new Date(Number(buf.readBigUInt64LE(41))).toISOString(),
    };
  }
  if (tag === 0x03) {
    if (buf.length !== 73) throw new Error(`PltConfirmed event wrong length: ${buf.length}`);
    return {
      event: 'PltConfirmed',
      payableId: id,
      payer: accountFromBytes(buf.subarray(9, 41)),
      txHash: buf.subarray(41, 73).toString('hex'),
    };
  }
  throw new Error(`unknown contract event tag 0x${tag.toString(16)} (len ${buf.length})`);
}

/** All decoded contract-logged events from an `Updated` summary event. */
export function decodeLoggedEvents(updatedEvent) {
  const out = [];
  for (const hex of updatedEvent?.events ?? []) {
    try {
      out.push(decodeContractEvent(hex));
    } catch (e) {
      out.push({ event: 'Unknown', raw: hex, error: e.message });
    }
  }
  return out;
}
