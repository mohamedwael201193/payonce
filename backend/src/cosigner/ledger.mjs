// PayOnce backend — co-signer ledger (append-only JSONL).
// Every co-signed transfer is recorded BEFORE the signature is returned
// (plan C-35: if this write fails, the service refuses and signs nothing).
// The ledger is the recheck source: cosign-recheck replays it against chain
// state and reports any entry whose transfer never finalized.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export function loadLedger(path) {
  if (!existsSync(path)) return { entries: [] };
  const entries = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return { entries };
}

/** Append one entry. Throws on failure — the caller must refuse, not sign. */
export function appendEntry(path, entry) {
  const line = JSON.stringify({ ...entry, seq: entry.seq ?? Date.now() }) + '\n';
  const fd = appendFileSync(path, line, { flag: 'a' });
  return fd;
}

export function unresolvedEntries(ledger, payableKey) {
  return (ledger.entries ?? []).filter(
    (e) => e.payableKey === payableKey && e.state === 'unresolved',
  );
}

export function ledgerForDecide(ledger, payableKey) {
  return { unresolved: unresolvedEntries(ledger, payableKey) };
}
