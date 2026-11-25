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
import { getPayable, getRegistryBalance, accountFromBytes } from '../registry.mjs';
import { getPayableV2, getRegistryBalanceV2, REGISTRY_V2_1, CONTRACT_NAME_V2_1 } from '../v2/registry.mjs';
import { decodeLoggedEventsForGen } from '../events.mjs';
import { verifyCcd, verifyPlt, PAY_CCD_TARGETS, RESERVE_TARGETS, CONFIRM_TARGETS, findTargetUpdated } from './checks.mjs';

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

  // PLT rail: the reserve / confirm txs are fetched first — a
  // TokenTransfer carries no Updated event, so the registry decision for
  // the PLT rail comes from the reserve tx (else the confirm tx).
  let reserveSummary = null;
  let reserveBlockTime = null;
  let confirmSummary = null;
  let confirmBlockTime = null;
  if (rail === 'plt') {
    const reserveTx = opt('--reserve-tx');
    if (reserveTx) {
      reserveSummary = await getTxStatus(client, reserveTx.toLowerCase());
      reserveBlockTime = await getBlockTime(client, reserveSummary.blockHash);
    }
    const confirmTx = opt('--confirm-tx');
    if (confirmTx) {
      confirmSummary = await getTxStatus(client, confirmTx.toLowerCase());
      confirmBlockTime = await getBlockTime(client, confirmSummary.blockHash);
    }
  }

  // G7 fix-back MF1 (compliance): the payable view + registry balance
  // come from the registry the tx actually targeted — never a hardcoded
  // v1. CCD rail: the pay tx's pay_ccd Updated event. PLT rail: the
  // reserve tx's reserve_plt Updated (else the confirm tx's confirm_plt).
  // v2/v2.1 views are keyed by the seller decoded from the 40-byte
  // PayableKeyParam. No target matches -> v1, exactly the old behaviour
  // (v1 CCD payable 6, v1 PLT payable 2 verify unchanged).
  let registryIndex = '13149';
  let gen = 'v1';
  let seller = null;
  const targetSource =
    rail === 'ccd'
      ? findTargetUpdated(summary, PAY_CCD_TARGETS)
      : findTargetUpdated(reserveSummary, RESERVE_TARGETS) ?? findTargetUpdated(confirmSummary, CONFIRM_TARGETS);
  if (targetSource) {
    gen = targetSource.target.gen;
    registryIndex = targetSource.target.index;
    if (gen === 'v2') {
      const msg = targetSource.event.message ? Buffer.from(targetSource.event.message, 'hex') : null;
      if (msg?.length === 40) seller = accountFromBytes(msg.subarray(0, 32));
    }
  }
  // A v2/v2.1 target whose parameter is not a PayableKeyParam cannot key
  // a v2 view: fail closed with a named error instead of silently reading
  // the WRONG registry's payable (the v1/v2 id collision that made the
  // old CLI report 8/11 on a good v2 payment).
  if (gen === 'v2' && !seller) {
    throw new Error(`tx targets registry <${registryIndex},0> but its parameter is not a 40-byte PayableKeyParam (seller + id) — cannot read the v2 view; supply the matching --reserve-tx for the PLT rail`);
  }

  let view;
  let balance;
  if (gen === 'v1') {
    view = await getPayable(client, payableId);
    balance = await getRegistryBalance(client);
  } else if (registryIndex === '13152') {
    view = await getPayableV2(client, seller, payableId, null, REGISTRY_V2_1, CONTRACT_NAME_V2_1);
    balance = await getRegistryBalanceV2(client, REGISTRY_V2_1);
  } else {
    view = await getPayableV2(client, seller, payableId);
    balance = await getRegistryBalanceV2(client);
  }
  const ctx = { payableId, txHash, summary, blockTime, view, balance, registryIndex };
  if (rail === 'plt') {
    if (reserveSummary) {
      // G7 fix-back MF1 (adversarial/compliance): the reserve's logged
      // events decode with the generation's own decoder — a v2 Reserved
      // (tag 0x04, 82 B) via the v1 decoder comes back {event:'Unknown'}
      // and PLT-13 can never pass. The reserve also carries its
      // registry/generation so PLT-13 can bind it (checks.mjs MF4).
      const found = findTargetUpdated(reserveSummary, RESERVE_TARGETS);
      ctx.reserve = {
        blockTime: reserveBlockTime,
        logged: found ? decodeLoggedEventsForGen(found.event, found.target.gen) : [],
        gen: found?.target.gen ?? 'v1',
        registryIndex: found?.target.index ?? '13149',
      };
    }
    if (confirmSummary) {
      // G7 fix-back-4 ADV-2: the confirm carries its decoded PltConfirmed
      // event (generation-aware, like the reserve above) — PLT-12 now
      // requires the event, not just the block time.
      const found = findTargetUpdated(confirmSummary, CONFIRM_TARGETS);
      ctx.confirm = { blockTime: confirmBlockTime, logged: found ? decodeLoggedEventsForGen(found.event, found.target.gen) : [] };
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
    // G7 fix-back-3 MF-2: fixture JSON carries no registry by
    // construction — the unbound opt-in is explicit here, so fixture
    // runs keep the old behaviour instead of failing CCD-03/PLT-13.
    unbound: true,
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
// G7 fix-back-2 F-A: the CLI fails closed on a missing reserve — a PLT
// run without --reserve-tx gets an explicit named PLT-13 FAIL, not a
// silent SKIP (it used to fail only incidentally via PLT-11). Confirm
// stays operator-supplied: without --confirm-tx PLT-12 still SKIPs,
// preserving the reserve-only 11/13+2-skip shape.
if (rail === 'plt') ctx.requireReserve = true;
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
