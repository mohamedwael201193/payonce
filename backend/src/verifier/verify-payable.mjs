// PayOnce backend — keyless verifier CLI (v2, F10 fixed).
// Usage:
//   node src/verifier/verify-payable.mjs <payable-id> <tx-hash> [--rail ccd|plt]
//       [--doc <invoice-file>] [--reserve-tx <hash>] [--confirm-tx <hash>]
//       [--fixture <dir>] [--json]
// Live mode reads only from the testnet node (no keys, no sends).
// Fixture mode runs offline from saved JSON (see test/fixtures/).
// Exit code 0 when every non-skipped check passes, 1 otherwise.
import { readFileSync, existsSync } from 'node:fs';
import { grpcClient, getTxStatus, getBlockTime, REGISTRY_V1 } from '../chain.mjs';
import { getPayable, getRegistryBalance } from '../registry.mjs';
import { decodeLoggedEvents } from '../events.mjs';
import { verifyCcd, verifyPlt } from './checks.mjs';

function usage() {
  console.log(`Usage: node verify-payable.mjs <payable-id> <tx-hash> [--rail ccd|plt] [--doc <file>] [--reserve-tx <hash>] [--confirm-tx <hash>] [--fixture <dir>] [--json]`);
  process.exit(2);
}

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const opt = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
if (positional.length < 2) usage();
const payableId = Number(positional[0]);
const txHash = positional[1].toLowerCase();
const rail = opt('--rail') ?? 'ccd';
const fixtureDir = opt('--fixture');
const asJson = args.includes('--json');
if (!Number.isInteger(payableId) || payableId < 0) usage();
if (!/^[0-9a-f]{64}$/.test(txHash)) usage();
if (rail !== 'ccd' && rail !== 'plt') usage();

async function loadLive() {
  const client = grpcClient();
  const summary = await getTxStatus(client, txHash);
  const blockTime = await getBlockTime(client, summary.blockHash);
  const view = await getPayable(client, payableId);
  const balance = await getRegistryBalance(client);
  const ctx = { payableId, txHash, summary, blockTime, view, balance };
  if (rail === 'plt') {
    const reserveTx = opt('--reserve-tx');
    if (reserveTx) {
      const rs = await getTxStatus(client, reserveTx.toLowerCase());
      const rbt = await getBlockTime(client, rs.blockHash);
      const upd = (rs.summary?.events ?? []).find(
        (e) => e.tag === 'Updated' && String(e.address?.index) === '13149' && e.receiveName === 'payable_registry.reserve_plt',
      );
      ctx.reserve = { blockTime: rbt, logged: upd ? decodeLoggedEvents(upd) : [] };
    }
    const confirmTx = opt('--confirm-tx');
    if (confirmTx) {
      const cs = await getTxStatus(client, confirmTx.toLowerCase());
      const cbt = await getBlockTime(client, cs.blockHash);
      ctx.confirm = { blockTime: cbt };
    }
  }
  return ctx;
}

function loadFixture() {
  const read = (name) => JSON.parse(readFileSync(`${fixtureDir}/${name}`, 'utf8'));
  const ctx = {
    payableId,
    txHash,
    summary: read('tx.json'),
    blockTime: read('blockTime.json'),
    view: read('view.json'),
    balance: existsSync(`${fixtureDir}/balance.txt`) ? readFileSync(`${fixtureDir}/balance.txt`, 'utf8').trim() : '0',
  };
  if (rail === 'plt') {
    if (existsSync(`${fixtureDir}/reserve.json`)) ctx.reserve = read('reserve.json');
    if (existsSync(`${fixtureDir}/confirm.json`)) ctx.confirm = read('confirm.json');
  }
  return ctx;
}

let ctx = fixtureDir ? loadFixture() : await loadLive();
const docPath = opt('--doc');
if (docPath) ctx.docBytes = readFileSync(docPath);
const result = rail === 'ccd' ? verifyCcd(ctx) : verifyPlt(ctx);

if (asJson) {
  console.log(JSON.stringify({ payableId, txHash, rail, ...result }, null, 2));
} else {
  console.log(`PayOnce verifier v2 — payable ${payableId}, rail ${rail.toUpperCase()}, tx ${txHash.slice(0, 12)}…`);
  for (const c of result.checks) {
    console.log(`  [${c.status}] ${c.id} ${c.name} — ${c.detail}`);
  }
  const counted = result.checks.filter((c) => c.status !== 'SKIP').length;
  const passedCounted = result.checks.filter((c) => c.status === 'PASS').length;
  if (result.allPass) {
    console.log(`ALL CHECKS PASS (${passedCounted}/${counted}${result.skipped ? `, ${result.skipped} skipped` : ''})`);
  } else {
    console.log(`FAILURES: ${result.failed} of ${counted} checks failed (${passedCounted}/${counted} passed${result.skipped ? `, ${result.skipped} skipped` : ''})`);
  }
}
process.exit(result.allPass ? 0 : 1);
