#!/usr/bin/env node
// Sample verification of the census identity attribution against a Concordium node (read-only).
// Re-reads getAccountInfo for every business-identity account + a seeded random sample, compares with census_*.csv,
// writes census_verification.json and exits 1 on any mismatch or node error. Same code as GET /api/census/verify.
// Needs: gRPC reachability (:20000) and `npm ci --prefix api`.   node tools/census/verify-sample.mjs [--n 25] [--seed 7] [--out file] [--run-by github-actions]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv, runVerification } from '../../api/src/census-verify.mjs';
const here = fileURLToPath(new URL('.', import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const rowsByNet = { mainnet: parseCsv(readFileSync(here + 'census_mainnet.csv', 'utf8')), testnet: parseCsv(readFileSync(here + 'census_testnet.csv', 'utf8')) };
let gen = null; try { gen = JSON.parse(readFileSync(here + 'census_public.json', 'utf8')).generated_at_utc; } catch { /* none */ }
const d = new Date(); const defSeed = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
const res = await runVerification({ rowsByNet, censusGeneratedAt: gen, n: Number(arg('--n', 25)), seed: Number(arg('--seed', defSeed)), runBy: arg('--run-by', 'cli') });
for (const [net, x] of Object.entries(res.networks)) {
  console.log(`${net}: ${x.agree}/${x.agree + x.mismatch} attributions agree with the node (business-identity accounts ${x.business_agree}/${x.business_accounts_in_census}); ${x.node_errors} node errors, ${x.census_unattributed} unattributed`);
  for (const a of x.accounts.filter((r) => r.result === 'mismatch')) console.log(`  MISMATCH ${a.account}: census=${a.census.join('|')} node=${a.node.join('|')}`);
}
const out = arg('--out', here + 'census_verification.json');
writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
console.log(`all_agree=${res.all_agree}  wrote ${out}`);
process.exit(res.all_agree ? 0 : 1);
