// PayOnce API server — co-signer ledger (append-only).
// Mirrors backend src/cosigner/ledger.mjs: a co-signed transfer is written
// FIRST as `unresolved`, and resolved when its confirm lands (C-35: ledger
// first, signature second). decide() refuses a new reserve/transfer for a
// payable with an unresolved entry (`ledger-unresolved`).
// The ledger is the server's own record — it never holds keys.
// Storage: Postgres payonce_ledger when DATABASE_URL is set, the JSONL file
// under api/data/ otherwise (see src/store.mjs).
import { appendLedgerEntry, ledgerRows, resolveLedgerTransfer } from './store.mjs';
import { DATA_DIR } from './config.mjs';
import { join } from 'node:path';

export function ledgerPath() {
  return join(DATA_DIR, 'cosigner-ledger.jsonl');
}

export async function loadLedger() {
  return ledgerRows();
}

export async function appendEntry(entry) {
  return appendLedgerEntry(entry);
}

export async function ledgerForDecide(payableKey) {
  const unresolved = (await ledgerRows()).filter(
    (e) => e.payableKey === payableKey && e.state === 'unresolved',
  );
  return { unresolved };
}

/** Mark the unresolved transfer entry for a payable resolved (after confirm). */
export async function resolveTransfer(payableKey, txHash) {
  return resolveLedgerTransfer(payableKey, txHash);
}
