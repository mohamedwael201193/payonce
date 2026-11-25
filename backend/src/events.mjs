// PayOnce backend — contract-logged event decoders (v1 + v2/v2.1).
// Layouts validated live against the v1 txs (spikes/s5-s6.mjs,
// spikes/reserve-confirm-probe.mjs):
//   Registered:   0x00 + payable_id u64 LE + seller 32B + payee 32B + amount u64 LE (81 B)
//   Paid:         0x01 + payable_id u64 LE + payer 32B + amount u64 LE (49 B)
//   Reserved:     0x02 + payable_id u64 LE + payer 32B + expires u64 LE ms (49 B)
//   PltConfirmed: 0x03 + payable_id u64 LE + payer 32B + tx_hash 32B (73 B)
// v2 (<13150,0> payable_registry_v2) and v2.1 (<13152,0>
// payable_registry_v2_1) share one ContractEvent enum (same variant order,
// same field order — v2.1 only appends PaymentTxRecorded at the end, so the
// shared variants keep their tags). Every variant carries a leading
// schema_version u8 (v2 = 2, v2.1 = 3) and the seller key. Layouts validated
// live against payable 10's v2 pay tx 7c204f0b… (probe 2026-11-24):
//   Paid:         0x06 + schema_version u8 + seller 32B + payable_id u64 LE
//                 + payer 32B + amount u64 LE + asset u8 (0 = Ccd) (83 B)
//   Reserved:     0x04 + schema_version u8 + seller 32B + payable_id u64 LE
//                 + payer 32B + expires u64 LE ms (82 B)
//   Released:     0x05 + schema_version u8 + seller 32B + payable_id u64 LE (42 B)
//   PltConfirmed: 0x07 + schema_version u8 + seller 32B + payable_id u64 LE
//                 + payer 32B + tx_hash 32B + reservation_expires u64 LE ms (114 B)
//   Voided:       0x08 + schema_version u8 + seller 32B + payable_id u64 LE (42 B)
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

/**
 * v2/v2.1 contract-logged event decoder. Shared enum: tag byte, then
 * schema_version, then seller, then the variant fields. Throws on unknown
 * tags / wrong lengths / non-Ccd asset on Paid (fail-closed: a Plt-asset
 * Paid event has a longer layout and must never decode as a CCD payment).
 */
export function decodeContractEventV2(hex) {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length < 2) throw new Error('empty contract event');
  const tag = buf[0];
  const schemaVersion = buf[1];
  const seller = accountFromBytes(buf.subarray(2, 34));
  const id = Number(buf.readBigUInt64LE(34));
  if (tag === 0x04) {
    if (buf.length !== 82) throw new Error(`v2 Reserved event wrong length: ${buf.length}`);
    return {
      event: 'Reserved',
      schemaVersion,
      seller,
      payableId: id,
      payer: accountFromBytes(buf.subarray(42, 74)),
      expiresMs: u64le(buf, 74),
      expires: new Date(Number(buf.readBigUInt64LE(74))).toISOString(),
    };
  }
  if (tag === 0x05 || tag === 0x08) {
    if (buf.length !== 42) throw new Error(`v2 ${tag === 0x05 ? 'Released' : 'Voided'} event wrong length: ${buf.length}`);
    return { event: tag === 0x05 ? 'Released' : 'Voided', schemaVersion, seller, payableId: id };
  }
  if (tag === 0x06) {
    if (buf.length !== 83) throw new Error(`v2 Paid event wrong length: ${buf.length}`);
    if (buf[82] !== 0) throw new Error(`v2 Paid event has non-Ccd asset byte ${buf[82]}`);
    return {
      event: 'Paid',
      schemaVersion,
      seller,
      payableId: id,
      payer: accountFromBytes(buf.subarray(42, 74)),
      amount: u64le(buf, 74),
      asset: 'Ccd',
    };
  }
  if (tag === 0x07) {
    if (buf.length !== 114) throw new Error(`v2 PltConfirmed event wrong length: ${buf.length}`);
    return {
      event: 'PltConfirmed',
      schemaVersion,
      seller,
      payableId: id,
      payer: accountFromBytes(buf.subarray(42, 74)),
      txHash: buf.subarray(74, 106).toString('hex'),
      reservationExpiresMs: u64le(buf, 106),
      reservationExpires: new Date(Number(buf.readBigUInt64LE(106))).toISOString(),
    };
  }
  throw new Error(`unknown v2 contract event tag 0x${tag.toString(16)} (len ${buf.length})`);
}

/** All decoded v2/v2.1 contract-logged events from an `Updated` summary event. */
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

/**
 * Generation-aware decode of an `Updated` summary event's logged events.
 * v1 events (tags 0x00–0x03) decode ONLY with the v1 decoder and v2/v2.1
 * events (tags 0x04–0x08) ONLY with the v2 decoder — each decoder throws
 * on the other's tags, so a blanket decode in either direction can never
 * pass (G7 fix-back: the reserve seek decoded every generation with the
 * v1 decoder, so a v2 Reserved event came back {event:'Unknown'} and
 * PLT-13 failed). gen is 'v1' or 'v2' (v2.1 shares the v2 shapes).
 */
export function decodeLoggedEventsForGen(updatedEvent, gen) {
  return gen === 'v2' ? decodeLoggedEventsV2(updatedEvent) : decodeLoggedEvents(updatedEvent);
}
