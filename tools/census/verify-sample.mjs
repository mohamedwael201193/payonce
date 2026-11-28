#!/usr/bin/env node
// Sample verification of the census identity attribution against a node (read-only).
// The census attributes each account's identity provider from CCDExplorer's public page (the census host cannot reach gRPC).
// This re-reads getAccountInfo from a node for a seeded random sample (+ every business-identity account) and reports agreement.
// Needs: tools/census/census_*.csv and the api deps (run from the repo: cd api && npm ci). Usage: node tools/census/verify-sample.mjs [--n 25] [--seed 7]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { ConcordiumGRPCNodeClient } = await import(require.resolve('@concordium/web-sdk/nodejs'));
const { AccountAddress } = await import(require.resolve('@concordium/web-sdk'));
const { credentials } = await import(require.resolve('@grpc/grpc-js'));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('--n', 25)); let seed = Number(arg('--seed', 7));
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const HOSTS = { mainnet: 'grpc.mainnet.concordium.software', testnet: 'grpc.testnet.concordium.com' };
const IDP = { mainnet: { 1: 'Notabene', 2: 'Digital Trust Solutions', 3: 'Global FinReg' }, testnet: { 0: 'Concordium testnet IP', 3: 'Digital Trust Solutions TestNet', 4: 'Global FinReg Testnet', 5: 'Dataspike' } };
const csv = (f) => { const [h, ...r] = readFileSync(here + f, 'utf8').trim().split('\n'); const k = h.split(','); return r.map((l) => Object.fromEntries(l.split(',').map((v, i) => [k[i], v]))); };
let bad = 0;
for (const net of ['mainnet', 'testnet']) {
  const rows = csv(`census_${net}.csv`); const m = new Map();
  for (const r of rows) { const p = r.agent_wallet || r.owner_account; m.set(p, r.agent_wallet ? r.payee_idp : r.owner_idp); m.set(r.owner_account, r.owner_idp); }
  const all = [...m.keys()]; const biz = all.filter((a) => /Global FinReg/.test(m.get(a)));
  const sample = new Set(biz); while (sample.size < Math.min(all.length, biz.length + N)) sample.add(all[Math.floor(rnd() * all.length)]);
  const c = new ConcordiumGRPCNodeClient(HOSTS[net], 20000, credentials.createSsl());
  let ok = 0, n = 0, bizOk = 0, errs = 0;
  for (const a of sample) {
    try {
      const info = await c.getAccountInfo(AccountAddress.fromBase58(a));
      const got = [...new Set(Object.values(info.accountCredentials).map((x) => IDP[net][x.value.contents.ipIdentity] ?? `idp ${x.value.contents.ipIdentity}`))].sort().join('|');
      const want = String(m.get(a)).split('|').sort().join('|'); n++;
      if (got === want) { ok++; if (biz.includes(a)) bizOk++; } else console.log(`MISMATCH ${net} ${a}: census=${want} node=${got}`);
    } catch (e) { errs++; console.log(`ERR ${net} ${a}: ${String(e.message).slice(0, 80)}`); }
  }
  console.log(`${net}: ${ok}/${n} identity-provider attributions agree with the node (business-identity accounts ${bizOk}/${biz.length}); ${errs} node errors`);
  if (ok !== n || errs) bad = 1;
}
process.exit(bad);
