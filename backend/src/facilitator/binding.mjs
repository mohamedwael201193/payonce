// PayOnce backend — PayOnce payable-binding layer for x402 verify (testnet only).
//
// Shared by BOTH facilitator paths:
//   - self-hosted (`scheme.mjs` payonceVerify: scheme verify first, then bind),
//   - hosted (`hosted-payonce.mjs`: hosted /verify first, then bind).
// One implementation, one set of check names — the two paths can never drift.
//
// The binding is what the stock x402 scheme does NOT do: the transfer must
// belong to a real payable (exists, right status, amount == stored amount,
// payee == stored payee, and for PLT the signed tx must carry the canonical
// CBOR memo `payable:<id>` — the hosted facilitator never checks the memo,
// so this layer is what stops a valid hosted payment for the WRONG payable).
//
// `verifyResult` is the facilitator's own verdict ({isValid, payer,
// invalidReason?, invalidMessage?}); `loadPayable(payableId)` returns the
// on-chain payable view ({id, status, asset, amount, payee}) or throws.
// Nothing here signs, submits, or reads any key.
import { encodeCborMemo } from '../chain.mjs';

/**
 * Minimal CBOR walker: extract every text-string value in a CBOR document,
 * each with the exact raw bytes that encoded it AND whether it was found
 * inside a tag-24 inner encoding (`viaTag24`). Exported for tests.
 * Returns null when the hex is not exactly one well-formed CBOR value.
 * Handles all major types, indefinite lengths, and tags — including tag 24,
 * which the Concordium PLT memo uses: the memo is a tag-24-wrapped byte
 * string whose CONTENT is itself the CBOR text encoding of the memo string,
 * so the inner bytes are parsed as CBOR too and their text values collected
 * (marked viaTag24). (The SDK's `Cbor.decode` is a PLT-module-state decoder,
 * not a generic CBOR decoder, so it cannot do this job — hence the walker.)
 * The binding's memo-canonical check credits ONLY viaTag24 texts: a genuine
 * PLT memo is ALWAYS tag-24-wrapped by the SDK (CborMemo.fromString), so a
 * bare text value — a memo as a map KEY, or as a stray array element — is
 * not a memo field and no longer passes. (FIXBACK3 B1: a viaTag24 text is
 * credited ONLY when the tag-24 inner CBOR value IS itself exactly one
 * definite-length text string. The fix-back-2 walker credited any text
 * found ANYWHERE inside a tag-24 inner encoding — a MAP key, a
 * double-wrapped tag-24, or an ARRAY element inside the inner all passed —
 * so "the walker guarantees a real memo field" was false. Now the inner
 * value's major type must be 3 (text), definite length, consuming exactly
 * the inner bytes.)
 * Residual (documented, not hidden): a bare (non-op) CBOR array carrying a
 * lone tag-24 memo as an element — e.g. `[1, tag24memo]` — still passes this
 * check, because the binding layer does not structurally validate the
 * operations array (it does not count ops). A genuine TWO-op tokenUpdate
 * whose second op carries its own tag-24 memo does NOT pass: the
 * memo-canonical check now requires EXACTLY ONE viaTag24 text in the whole
 * operations document (see checkPayableBinding). Closing the bare-array
 * shape needs operations-structure validation (top level must be an array
 * of exactly one op map) — that rests on the facilitator's exactly-1-op
 * enforcement, verified in the self-hosted scheme source but NOT verifiable
 * for the hosted facilitator without a seed-signed multi-op payload.
 */
export function extractCborTexts(hex) {
  if (typeof hex !== 'string' || !hex) return null;
  let buf;
  try { buf = Buffer.from(hex, 'hex'); } catch { return null; }
  if (buf.length === 0 || buf.toString('hex') !== hex.toLowerCase()) return null;
  const texts = [];
  try {
    const { end } = readCborValue(buf, 0, texts);
    if (end !== buf.length) return null; // trailing bytes: not a single CBOR value
    return texts;
  } catch { return null; }
}

function readCborHead(b, off) {
  if (off >= b.length) throw new Error('truncated');
  const b0 = b[off];
  const mt = b0 >> 5;
  const ai = b0 & 0x1f;
  let len;
  let n = 1;
  if (ai < 24) len = ai;
  else if (ai === 24) { len = b[off + 1]; n = 2; }
  else if (ai === 25) { len = b.readUInt16BE(off + 1); n = 3; }
  else if (ai === 26) { len = b.readUInt32BE(off + 1); n = 4; }
  else if (ai === 27) { len = Number(b.readBigUInt64BE(off + 1)); n = 9; }
  else if (ai === 31) len = null; // indefinite length
  else throw new Error('reserved additional info');
  return { mt, len, headLen: n };
}

function readCborValue(b, off, texts) {
  const { mt, len, headLen } = readCborHead(b, off);
  const start = off;
  off += headLen;
  if (mt === 0 || mt === 1) return { end: off }; // uint / nint: no payload beyond the header
  if (mt === 2) { // byte string
    if (len === null) {
      for (;;) {
        if (b[off] === 0xff) { off += 1; break; }
        off = readCborValue(b, off, texts).end;
      }
      return { end: off };
    }
    return { end: off + len };
  }
  if (mt === 3) { // text string
    if (len === null) {
      let text = '';
      for (;;) {
        if (b[off] === 0xff) { off += 1; break; }
        const r = readCborValue(b, off, texts);
        text += r.text ?? '';
        off = r.end;
      }
      texts.push({ text, rawHex: b.subarray(start, off).toString('hex'), start, end: off, viaTag24: false });
      return { end: off, text };
    }
    const text = b.subarray(off, off + len).toString('utf8');
    const end = off + len;
    texts.push({ text, rawHex: b.subarray(start, end).toString('hex'), start, end, viaTag24: false });
    return { end, text };
  }
  if (mt === 4) { // array
    if (len === null) { while (b[off] !== 0xff) off = readCborValue(b, off, texts).end; return { end: off + 1 }; }
    for (let i = 0; i < len; i++) off = readCborValue(b, off, texts).end;
    return { end: off };
  }
  if (mt === 5) { // map
    if (len === null) { while (b[off] !== 0xff) { off = readCborValue(b, off, texts).end; off = readCborValue(b, off, texts).end; } return { end: off + 1 }; }
    for (let i = 0; i < len; i++) { off = readCborValue(b, off, texts).end; off = readCborValue(b, off, texts).end; }
    return { end: off };
  }
  if (mt === 6) { // tag: the tagged value follows
    // Tag 24 wraps CBOR inside a byte string: parse the inner bytes as CBOR too.
    if (len === 24) {
      const inner = readCborValue(b, off, texts);
      const h = readCborHead(b, off);
      if (h.mt === 2 && h.len !== null) {
        const innerBytes = b.subarray(off + h.headLen, off + h.headLen + h.len);
        // FIXBACK3 B1: credit a viaTag24 text ONLY when the tag-24 inner
        // CBOR value IS itself exactly one definite-length text string
        // (major type 3). A map key, a double-wrapped tag-24, or an array
        // element inside the inner encoding is not a memo text — the old
        // code credited any text found anywhere inside the inner bytes.
        try {
          const ih = readCborHead(innerBytes, 0);
          if (ih.mt === 3 && ih.len !== null) {
            const innerTexts = [];
            const r = readCborValue(innerBytes, 0, innerTexts);
            if (r.end === innerBytes.length && innerTexts.length === 1) {
              for (const t of innerTexts) texts.push({ ...t, viaTag24: true });
            }
          }
        } catch { /* content is not CBOR: ignore */ }
      }
      return inner;
    }
    return readCborValue(b, off, texts);
  }
  // Major type 7 (simple/float): the header length already covers the value.
  if (len === null) throw new Error('break outside indefinite length');
  return { end: off };
}

/**
 * Run the PayOnce binding checks after a facilitator verify.
 * Returns { isValid, payer, invalidReason?, invalidMessage?, payonce: { checks, view? } }.
 * Check names/order are identical to the original payonceVerify implementation.
 */
export async function checkPayableBinding({ verifyResult, payload, requirements, payableId, expectedStatus = null, loadPayable }) {
  const checks = [];
  const fail = (reason, message) => ({ isValid: false, payer: '', invalidReason: reason, invalidMessage: message, payonce: { checks } });
  const v = verifyResult;
  checks.push({ name: 'x402-9-checks', ok: v.isValid, detail: v.isValid ? 'scheme verify passed' : `${v.invalidReason}: ${v.invalidMessage ?? ''}` });
  if (!v.isValid) return fail(v.invalidReason ?? 'x402_verify_failed', v.invalidMessage ?? 'scheme verify failed');
  let view = null;
  try {
    view = await loadPayable(payableId);
  } catch (e) {
    checks.push({ name: 'payable-exists', ok: false, detail: String(e.message).slice(0, 120) });
    return fail('payable_not_found', `payable ${payableId} not found: ${e.message}`);
  }
  checks.push({ name: 'payable-exists', ok: true, detail: `status=${view.status} asset=${view.asset} amount=${view.amount}` });
  if (expectedStatus && view.status !== expectedStatus) {
    checks.push({ name: 'payable-status', ok: false, detail: `expected ${expectedStatus}, got ${view.status}` });
    return fail('payable_wrong_status', `payable ${payableId} is ${view.status}, expected ${expectedStatus}`);
  }
  checks.push({ name: 'payable-status', ok: true, detail: `status=${view.status}` });
  if (String(requirements.amount) !== String(view.amount)) {
    checks.push({ name: 'amount-is-stored', ok: false, detail: `requirements=${requirements.amount}, stored=${view.amount}` });
    return fail('amount_mismatch', `requirements amount ${requirements.amount} != stored ${view.amount}`);
  }
  checks.push({ name: 'amount-is-stored', ok: true, detail: `amount=${view.amount}` });
  if (requirements.payTo !== view.payee) {
    checks.push({ name: 'payee-is-stored', ok: false, detail: `payTo=${requirements.payTo}, stored=${view.payee}` });
    return fail('payee_mismatch', `payTo ${requirements.payTo} != stored payee ${view.payee}`);
  }
  checks.push({ name: 'payee-is-stored', ok: true, detail: `payee=${view.payee}` });
  if (view.asset !== 'CCD') {
    const opsHex = payload?.payload?.signedTransaction?.payload?.operations ?? null;
    const memoHex = encodeCborMemo(`payable:${payableId}`).toString('hex');
    const hasMemo = typeof opsHex === 'string' && opsHex.toLowerCase().includes(memoHex);
    checks.push({ name: 'memo-is-payable-id', ok: hasMemo, detail: hasMemo ? `memo payable:${payableId} present` : 'canonical memo bytes missing from operations' });
    if (!hasMemo) return fail('memo_missing', `transfer carries no canonical memo payable:${payableId}`);
    // The memo must be EXACTLY `payable:<id>` as a standalone CBOR text
    // value, encoded canonically — not a longer string that merely contains
    // those bytes (e.g. `ipayable:9` contains the `payable:9` bytes but is a
    // different memo) — AND it must sit inside the tag-24 memo structure
    // (viaTag24), which is where the SDK always puts a PLT memo. A bare
    // text value (memo as a map key, or as a stray array element) is not a
    // memo field and fails here. The substring check above is only the
    // first gate; this check decodes the memo bytes ACTUALLY FOUND in the
    // operations (CBOR-walked, including the tag-24 inner encoding) and
    // requires one found tag-24 text value to equal `payable:<id>` with raw
    // bytes exactly memoHex (canonical shortest-form encoding). A longer
    // containing memo, a non-canonical encoding, a bare-text memo, or
    // unparseable operations all fail here.
    const found = extractCborTexts(opsHex);
    // FIXBACK3 B1 (second-op half): the operations document must contain
    // EXACTLY ONE tag-24 memo text in total, and it must be the canonical
    // memo. A genuine single-op tokenUpdate has exactly one memo; a second
    // op carrying its own tag-24 memo (same or different payable id) gives
    // two viaTag24 texts and fails here. This does not close the bare-array
    // residual ([1, tag24memo] — one memo text in a non-op array); see the
    // extractCborTexts header comment for that disposition.
    const viaTag24Texts = (found ?? []).filter((t) => t.viaTag24 === true);
    const exact = viaTag24Texts.length === 1
      && viaTag24Texts[0].text === `payable:${payableId}` && viaTag24Texts[0].rawHex === memoHex;
    const foundMemo = found?.find((t) => t.text.includes('payable:'))?.text ?? '(none found)';
    checks.push({ name: 'memo-canonical', ok: exact, detail: exact ? `memo=${foundMemo} canonical=true` : `memo found in ops=${foundMemo} (not exactly canonical payable:${payableId}${viaTag24Texts.length > 1 ? `; ${viaTag24Texts.length} tag-24 memo texts found, expected exactly one` : ''})` });
    if (!exact) return fail('memo_not_canonical', `transfer memo is not exactly the canonical memo payable:${payableId} (found: ${foundMemo})`);
  }
  return { isValid: true, payer: v.payer, payonce: { checks, view } };
}
