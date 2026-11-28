// Transaction hashes known BEFORE sending. web-sdk 12.0.3 Transaction.getAccountTransactionHash hashes the account
// transaction without the block-item kind byte, while the node's transaction hash covers the serialized block item.
// (Found 28 Nov 2026: a fixture propose_payee landed as 9ea8268b... while the SDK hash was 000496c4..., so the earlier
// "transaction not found" in the dash E2E came from looking up the wrong hash.) Every sender stores ALL candidates
// before submitting, adopts the hash the node returns, and looks up every candidate when the outcome is unknown.
import { createHash } from 'node:crypto';
import { Transaction } from '@concordium/web-sdk';

/** [block-item hash, sdk account-transaction hash] (deduplicated, hex) for a finalized (signed) transaction. */
export function hashCandidates(fin) {
  const item = createHash('sha256').update(Buffer.from(Transaction.serializeBlockItem(fin))).digest('hex');
  const raw = Buffer.from(Transaction.getAccountTransactionHash(fin)).toString('hex');
  return [...new Set([item, raw])];
}
/** The node's answer to sendTransaction as hex (TransactionHash, Uint8Array or string). */
export function returnedHash(r) {
  if (r == null) return null;
  if (typeof r === 'string') return /^[0-9a-f]{64}$/i.test(r) ? r.toLowerCase() : null;
  try { const s = r.toString(); if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase(); } catch { /* fallthrough */ }
  const b = r.buffer ?? r; try { const h = Buffer.from(b).toString('hex'); return h.length === 64 ? h : null; } catch { return null; }
}
