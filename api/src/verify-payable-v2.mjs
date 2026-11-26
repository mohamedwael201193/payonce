// verify-payable-v2.mjs — keyless v2 verifier CLI (for judges).
// Re-runs the whole verification from chain alone: no wallet, no key,
// no .env, read-only. Usage:
//   node verify-payable-v2.mjs <payable-id> <tx-hash> [--doc <path>] [--rail ccd|eudemo]
//        [--seller <address>] [--reserve <tx-hash>] [--confirm <tx-hash>]
//   node verify-payable-v2.mjs 10 7c204f0b… [--doc invoice-010-v2-ccd.txt]
//   node verify-payable-v2.mjs 11 690c5e2b… [--doc invoice-011-v2-eudemo.txt]
// The payable id is the (seller, id) key with seller = the demo seller
// (the owner). <tx-hash> is the pay_ccd tx (CCD) or the EUDemo transfer
// tx (EUDemo). Without --doc the doc check is reported as NOT RUN.
// Exit 0 when every runnable check passes, 1 otherwise.
// Requires: npm install in this package (api/) and in the backend/
// (the backend modules are imported from there — see backend.mjs).
import { readFileSync } from 'node:fs';
import { backend } from './backend.mjs';
import {
  grpc, chainNow, getPayable, getRegistryBalance, getTx, getBlockTime,
  SELLER, SELLER2, updatedEvent,
} from './chain-v2.mjs';
import { REGISTRY } from './config.mjs';
import { verifyCcdV2, verifyPltV2 } from './verifier-v2.mjs';

const [,, idArg, txArg, ...rest] = process.argv;
let docPath = null;
let railArg = null;
let sellerArg = null;
let reserveArg = null;
let confirmArg = null;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--doc') docPath = rest[++i];
  else if (rest[i] === '--rail') railArg = rest[++i];
  else if (rest[i] === '--seller') sellerArg = rest[++i];
  else if (rest[i] === '--reserve') reserveArg = rest[++i];
  else if (rest[i] === '--confirm') confirmArg = rest[++i];
}
const payableId = Number(idArg);
if (!Number.isInteger(payableId) || payableId < 1 || !/^[0-9a-fA-F]{64}$/.test(txArg ?? '')) {
  console.error('usage: node verify-payable-v2.mjs <payable-id> <tx-hash> [--doc <path>] [--rail ccd|eudemo]');
  process.exit(2);
}
if (sellerArg && sellerArg !== SELLER && sellerArg !== SELLER2) {
  console.error('unknown --seller: expected seller 1 or seller 2 address');
  process.exit(2);
}
const seller = sellerArg ?? SELLER;
const docBytes = docPath ? readFileSync(docPath) : null;
const c = await grpc();
const view = await getPayable(c, seller, payableId);
const rail = railArg ?? (view.asset === 'CCD' ? 'ccd' : 'eudemo');
const summary = await getTx(c, txArg.toLowerCase());
const blockTime = await getBlockTime(c, summary.blockHash);
const balance = await getRegistryBalance(c);
// PLT evidence (same shapes the server builds in pltEvidenceFor).
async function evidence(hash, name) {
  if (!hash) return null;
  const { v2ev } = await backend();
  const st = await getTx(c, hash.toLowerCase());
  const upd = updatedEvent(st, name);
  return { blockTime: await getBlockTime(c, st.blockHash), logged: upd ? v2ev.decodeLoggedEventsV2(upd) : [] };
}
const reserve = rail === 'eudemo' ? await evidence(reserveArg, 'reserve_plt') : null;
const confirmEv = rail === 'eudemo' ? await evidence(confirmArg, 'confirm_plt') : null;
const confirm = confirmEv ? { ...confirmEv, gen: 'v2' } : null;
const result = rail === 'ccd'
  ? await verifyCcdV2(c, { payableId, txHash: txArg.toLowerCase(), summary, blockTime, view, balance, docBytes })
  // G7 fix-back-7 MF-1: the registryIndex/gen pair below is passed for
  // interface stability only — the verifier no longer reads any
  // generation signal. This CLI reads the view from the v2 registry.
  : await verifyPltV2(c, { payableId, txHash: txArg.toLowerCase(), summary, blockTime, view, balance, docBytes, reserve, confirm, registryIndex: String(REGISTRY.index), gen: 'v2' });
for (const ch of result.checks) {
  console.log(`${ch.status === 'ok' ? 'PASS' : ch.status === 'fail' ? 'FAIL' : ch.status.toUpperCase()} ${ch.id} ${ch.detail}`);
}
console.log(result.allPass
  ? `ALL CHECKS PASS (${result.passed}/${result.total})`
  : `CHECKS FAILED (${result.passed}/${result.total} pass)`);
process.exit(result.allPass ? 0 : 1);
