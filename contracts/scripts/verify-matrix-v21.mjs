// verify-matrix.mjs — Re-reads EVERY matrix tx from the node (live truth-gate)
// and extracts the reject reason with the CORRECT field path:
// outcome.summary.rejectReason = { tag: 'RejectedReceive', rejectReason: <i32>, ... }
// (The matrix script looked for .reason / .contents.reason — the field is
// .rejectReason. The txs are NOT re-sent; this only reads them back.)
// Writes: matrix-v21-verified.json
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { TransactionHash } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
import fs from 'node:fs';

const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const input = JSON.parse(fs.readFileSync(new URL('./matrix-v21-result.json', import.meta.url), 'utf8'));
const out = [];
let passed = 0, total = 0;
for (const r of input.results) {
  if (!r.hash) { out.push(r); continue; } // view-only entries keep their flag
  total++;
  const s = await client.getBlockItemStatus(TransactionHash.fromHexString(r.hash));
  const sj = JSON.parse(JSON.stringify(s, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const summary = sj.outcome?.summary ?? {};
  const rr = summary.rejectReason ?? null;
  const code = rr && rr.tag === 'RejectedReceive' ? rr.rejectReason : null;
  const status = sj.status;
  const expected = r.expected;
  const pass = status === 'finalized' && (expected === null ? code === null : code === expected);
  if (pass) passed++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${r.label} | tx ${r.hash.slice(0, 16)}… | ${status} | reject ${code} | expected ${expected === null ? 'SUCCESS' : 'REJECT ' + expected} | energy ${summary.energyCost?.value} | cost ${summary.cost} microCCD`);
  out.push({ ...r, verifiedStatus: status, verifiedRejectCode: code, pass, energy: summary.energyCost?.value ?? null, costMicroCcd: summary.cost ?? null });
}
console.log(`\nVERIFIED: ${passed}/${total} tx cases pass (plus ${out.length - total} view/policy entries)`);
fs.writeFileSync(new URL('./matrix-v21-verified.json', import.meta.url), JSON.stringify({ contract: input.contract, verifiedPassed: passed, verifiedTotal: total, results: out }, null, 2));
