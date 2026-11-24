// PayOnce API server — co-signer ledger (append-only JSONL).
// Mirrors backend src/cosigner/ledger.mjs: a co-signed transfer is written
// FIRST as `unresolved`, and resolved when its confirm lands (C-35: ledger
// first, signature second). decide() refuses a new reserve/transfer for a
// payable with an unresolved entry (`ledger-unresolved`).
// The ledger is the server's own record — it never holds keys.
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.mjs';

const LEDGER_PATH = join(DATA_DIR, 'cosigner-ledger.jsonl');

export function ledgerPath() {
  return LEDGER_PATH;
}

export function loadLedger() {
  try {
    if (!existsSync(LEDGER_PATH)) return [];
    return readFileSync(LEDGER_PATH, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function appendEntry(entry) {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`);
}

export function ledgerForDecide(payableKey) {
  const unresolved = loadLedger().filter(
    (e) => e.payableKey === payableKey && e.state === 'unresolved',
  );
  return { unresolved };
}

/** Mark the unresolved transfer entry for a payable resolved (after confirm). */
export function resolveTransfer(payableKey, txHash) {
  const entries = loadLedger();
  let changed = false;
  const out = entries.map((e) => {
    if (e.payableKey === payableKey && e.state === 'unresolved' && (!txHash || e.txHash === txHash)) {
      changed = true;
      return { ...e, state: 'resolved' };
    }
    return e;
  });
  if (changed) {
    writeFileSync(LEDGER_PATH, out.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return changed;
}
