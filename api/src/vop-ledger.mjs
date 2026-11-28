// Hash-chained verdict receipts with an anchored head (G16). Testnet.
//
//   entry_hash = sha256("PVOPL1|" + seq + "|" + prev_hash + "|" + canonicalJson(entry))   (prev of seq 1 = 64 zeros)
//   head anchor = registerData "PVOH1" (5 bytes) + seq (u64 big-endian, 8 bytes) + head entry_hash (32 bytes) = 45 bytes
//
// Every check_payee answer the API gives, every signed approval and every dashboard payment outcome is appended. The
// head is anchored at most every 6 h (sooner, at most every 10 min, after a signed approval), within a daily budget.
// An anchor is claimed in the store before it is sent and is never resent when its status is unknown.
import { canonicalJson, sha256Hex } from './vop.mjs';

export const LEDGER_NS = 'vop_ledger';
export const ZERO = '0'.repeat(64);
export const HEAD_PREFIX = Buffer.from('PVOH1');
export const entryHash = (seq, prev, entry) => sha256Hex(`PVOPL1|${seq}|${prev}|${canonicalJson(entry)}`);
export function headBytesHex(seq, hash) {
  const s = Buffer.alloc(8); s.writeBigUInt64BE(BigInt(seq));
  return Buffer.concat([HEAD_PREFIX, s, Buffer.from(hash, 'hex')]).toString('hex');
}
export function parseHeadBytes(hex) {
  const b = Buffer.from(String(hex ?? ''), 'hex');
  if (b.length !== 45 || !b.subarray(0, 5).equals(HEAD_PREFIX)) return null;
  return { seq: Number(b.readBigUInt64BE(5)), head: b.subarray(13).toString('hex') };
}
const key = (seq) => `e:${String(seq).padStart(10, '0')}`;

/**
 * deps: { kv: {get, put, list}, now(), send(dataHex) -> {txHash} (throws with notSent=true when refused before acceptance),
 *         status(txHash) -> {status, dataHex}, gapMs?, urgentGapMs?, perDay? }
 */
export function createLedger(deps) {
  const now = deps.now ?? Date.now;
  const gapMs = deps.gapMs ?? 6 * 3_600_000;
  const urgentGapMs = deps.urgentGapMs ?? 10 * 60_000;
  const perDay = deps.perDay ?? 12;
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function head() { return (await deps.kv.get(LEDGER_NS, 'head')) ?? { seq: 0, hash: ZERO }; }

  function append(entry) {
    return serial(async () => {
      const h = await head();
      const seq = h.seq + 1;
      const clean = JSON.parse(JSON.stringify(entry));
      const hash = entryHash(seq, h.hash, clean);
      await deps.kv.put(LEDGER_NS, key(seq), { seq, prev: h.hash, hash, entry: clean, at: new Date(now()).toISOString() });
      await deps.kv.put(LEDGER_NS, 'head', { seq, hash });
      return { seq, entry_hash: hash, prev_hash: h.hash };
    });
  }

  /** Anchor the current head if it moved and the gap passed. Returns the anchor record or { skipped }. */
  function anchorHead({ urgent = false } = {}) {
    return serial(async () => {
      const h = await head();
      if (h.seq === 0) return { skipped: 'empty' };
      const last = await deps.kv.get(LEDGER_NS, 'anchor:last');
      if (last?.seq === h.seq) return { skipped: 'head already anchored', last };
      if (last && now() - Date.parse(last.at) < (urgent ? urgentGapMs : gapMs)) return { skipped: 'not due', last, next_at: new Date(Date.parse(last.at) + (urgent ? urgentGapMs : gapMs)).toISOString() };
      const day = `anchor:day:${new Date(now()).toISOString().slice(0, 10)}`;
      const used = (await deps.kv.get(LEDGER_NS, day))?.n ?? 0;
      if (used >= perDay) return { skipped: 'daily budget used', last };
      const dataHex = headBytesHex(h.seq, h.hash);
      const rec = { seq: h.seq, head: h.hash, data_hex: dataHex, at: new Date(now()).toISOString(), state: 'claimed', tx_hash: null };
      await deps.kv.put(LEDGER_NS, `anchor:${String(h.seq).padStart(10, '0')}`, rec);
      await deps.kv.put(LEDGER_NS, day, { n: used + 1 });
      let sent;
      try { sent = await deps.send(dataHex); } catch (e) {
        const st = e?.notSent === true ? 'failed_not_sent' : 'unknown';
        const r2 = { ...rec, state: st, note: st === 'unknown' ? 'No answer from the node: status unknown, NOT resent.' : String(e?.message ?? e).slice(0, 160) };
        await deps.kv.put(LEDGER_NS, `anchor:${String(h.seq).padStart(10, '0')}`, r2);
        if (st === 'unknown') await deps.kv.put(LEDGER_NS, 'anchor:last', r2);
        return r2;
      }
      const done = { ...rec, state: 'sent', tx_hash: sent.txHash };
      await deps.kv.put(LEDGER_NS, `anchor:${String(h.seq).padStart(10, '0')}`, done);
      await deps.kv.put(LEDGER_NS, 'anchor:last', done);
      return done;
    });
  }

  async function entries({ from = 1, limit = 100 } = {}) {
    const rows = (await deps.kv.list(LEDGER_NS)).filter((r) => String(r.key).startsWith('e:')).map((r) => r.value).sort((a, b) => a.seq - b.seq);
    return rows.filter((r) => r.seq >= Number(from)).slice(0, Math.min(Number(limit) || 100, 500));
  }

  /** Recompute the whole chain and read every anchor back from the chain. */
  async function verify() {
    const all = (await deps.kv.list(LEDGER_NS)).map((r) => ({ key: String(r.key), value: r.value }));
    const rows = all.filter((r) => r.key.startsWith('e:')).map((r) => r.value).sort((a, b) => a.seq - b.seq);
    const problems = [];
    let prev = ZERO;
    const bySeq = new Map();
    rows.forEach((r, i) => {
      if (r.seq !== i + 1) problems.push(`gap at seq ${i + 1}`);
      if (r.prev !== prev) problems.push(`seq ${r.seq}: prev does not link`);
      if (entryHash(r.seq, r.prev, r.entry) !== r.hash) problems.push(`seq ${r.seq}: hash does not recompute`);
      prev = r.hash; bySeq.set(r.seq, r.hash);
    });
    const h = await head();
    if (rows.length && (h.seq !== rows.at(-1).seq || h.hash !== rows.at(-1).hash)) problems.push('stored head is not the last entry');
    const anchors = [];
    for (const a of all.filter((r) => /^anchor:\d{10}$/.test(r.key)).map((r) => r.value).sort((x, y) => x.seq - y.seq)) {
      let onChain = null;
      if (a.tx_hash) { try { const st = await deps.status(a.tx_hash); onChain = { status: st.status, ...(parseHeadBytes(st.dataHex) ?? {}) }; } catch (e) { onChain = { error: String(e?.message ?? e).slice(0, 100) }; } }
      const matches = onChain?.seq === a.seq && onChain?.head === bySeq.get(a.seq);
      if (onChain?.status === 'finalized' && !matches) problems.push(`anchor seq ${a.seq}: chain data does not match the ledger`);
      anchors.push({ seq: a.seq, head: a.head, tx_hash: a.tx_hash, state: a.state, on_chain: onChain, matches_ledger: a.tx_hash ? matches : null });
    }
    return { ok: problems.length === 0, entries: rows.length, head: h, anchors, problems, rule: 'entry_hash = sha256("PVOPL1|" + seq + "|" + prev_hash + "|" + canonicalJson(entry)); anchor = registerData "PVOH1" + u64be(seq) + entry_hash' };
  }

  async function status() {
    const h = await head();
    return { head: h, last_anchor: await deps.kv.get(LEDGER_NS, 'anchor:last'), anchor_every_hours: gapMs / 3_600_000, format: { entry: 'sha256("PVOPL1|seq|prev|canonicalJson(entry)")', anchor: 'registerData "PVOH1" + u64be(seq) + head (45 bytes)' } };
  }

  return { append, anchorHead, entries, verify, status, head };
}
