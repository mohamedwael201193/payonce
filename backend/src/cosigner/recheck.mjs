// PayOnce backend — cosign-recheck CLI (public inputs only).
// Replays the co-signer ledger against chain state and proves the decision
// function is deterministic (same snapshot+request -> same decision).
//   node src/cosigner/recheck.mjs --ledger <path> [--out <report.json>]
// For each entry with state 'unresolved' and a txHash:
//   - transfer finalized AND the PLT verifier passes WITH PLT-13 and
//     PLT-12 both PASS (reservation + confirm evidence checked) -> resolved
//   - transfer finalized and the verifier passes but PLT-13/PLT-12 were
//     SKIPPED (no reserve/confirm evidence was loaded — the recheck CLI
//     loads only the transfer tx) -> transfer-only-verified, NEVER
//     resolved: allPass alone certifies a transfer whose reservation was
//     never checked (G7 fix-back-3 MF-1). 'resolved' is reachable only
//     from a future recheck that loads reserve/confirm evidence.
//   - reservation window passed with no finalized transfer -> expired
//   - otherwise -> still-pending
// Entries without a txHash are reported as 'no-tx-hash' (the facilitator
// links the submitted tx hash to the entry after submission).
// The ledger itself is never rewritten (append-only); the report is separate.
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { grpcClient, getTxStatus, getBlockTime } from '../chain.mjs';
import { getPayable, getRegistryBalance } from '../registry.mjs';
import { verifyPlt } from '../verifier/checks.mjs';
import { loadLedger } from './ledger.mjs';
import { decide } from './decide.mjs';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};

const ledgerPath = opt('--ledger') ?? fileURLToPath(new URL('../../data/cosigner-ledger.jsonl', import.meta.url));
const outPath = opt('--out');
const ledger = loadLedger(ledgerPath);
const client = grpcClient();
const report = [];

for (const entry of ledger.entries) {
  const item = { seq: entry.seq, kind: entry.kind, payableKey: entry.payableKey, state: entry.state };
  if (entry.state !== 'unresolved') {
    item.verdict = 'not-applicable';
    report.push(item);
    continue;
  }
  if (!entry.txHash) {
    item.verdict = 'no-tx-hash';
    report.push(item);
    continue;
  }
  const [, idStr] = entry.payableKey.split(':');
  const payableId = Number(idStr);
  try {
    const summary = await getTxStatus(client, entry.txHash);
    const blockTime = await getBlockTime(client, summary.blockHash);
    const view = await getPayable(client, payableId);
    const balance = await getRegistryBalance(client);
    const result = verifyPlt({ payableId, txHash: entry.txHash, summary, blockTime, view, balance });
    // G7 fix-back-3 MF-1: allPass alone is NOT 'resolved'. The recheck
    // loads no reserve/confirm evidence, so PLT-13/PLT-12 SKIP here and
    // the reservation was never checked — a transfer that verifies with
    // either SKIPPED is 'transfer-only-verified'. 'resolved' requires
    // both to PASS (only a future recheck that loads the evidence can
    // emit it).
    const plt13 = result.checks.find((c) => c.id === 'PLT-13');
    const plt12 = result.checks.find((c) => c.id === 'PLT-12');
    item.verdict = result.allPass
      ? (plt13?.status === 'PASS' && plt12?.status === 'PASS' ? 'resolved' : 'transfer-only-verified')
      : 'transfer-not-verified';
    item.failed = result.checks.filter((c) => c.status === 'FAIL').map((c) => c.id);
    item.txStatus = summary.status;
  } catch (e) {
    // Tx not found yet: check whether the window already passed.
    const now = Date.now();
    const expires = Number(entry.reservationExpires ?? 0);
    item.verdict = expires && now > expires ? 'expired' : 'still-pending';
    item.error = e.message;
  }
  report.push(item);
}

const unresolved = report.filter((r) => r.verdict === 'still-pending' || r.verdict === 'no-tx-hash').length;
const resolved = report.filter((r) => r.verdict === 'resolved').length;
const transferOnly = report.filter((r) => r.verdict === 'transfer-only-verified').length;
const expired = report.filter((r) => r.verdict === 'expired').length;
const bad = report.filter((r) => r.verdict === 'transfer-not-verified').length;
console.log(`recheck: ${report.length} entries — ${resolved} resolved, ${transferOnly} transfer-only, ${expired} expired, ${bad} not-verified, ${unresolved} pending/no-tx-hash`);
for (const r of report) console.log(`  ${r.seq} ${r.kind} ${r.payableKey}: ${r.verdict}${r.failed?.length ? ` (${r.failed.join(', ')})` : ''}`);
if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
