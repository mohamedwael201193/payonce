// verify-payable-v2.mjs — keyless v2 verifier CLI (for judges).
// Re-runs the whole verification from chain alone: no wallet, no key,
// no .env, read-only. Usage:
//   node verify-payable-v2.mjs <payable-id> <tx-hash> [--doc <path>] [--rail ccd|eudemo]
//        [--seller <address>] [--reserve <tx-hash>] [--confirm <tx-hash>]
// Failures print one plain line (exit 2 usage, 3 cannot read the chain/payable, 1 checks failed);
// never a stack trace.
//   node verify-payable-v2.mjs 10 7c204f0b… [--doc invoice-010-v2-ccd.txt]
//   node verify-payable-v2.mjs 11 690c5e2b… [--doc invoice-011-v2-eudemo.txt]
// The payable id is the (seller, id) key with seller = the demo seller
// (the owner). <tx-hash> is the pay_ccd tx (CCD) or the EUDemo transfer
// tx (EUDemo). Without --doc the doc check is reported as NOT RUN.
// Exit 0 when every runnable check passes, 1 otherwise.
// Requires: npm install in this package (api/) and in the backend/
// (the backend modules are imported from there — see backend.mjs).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseVerifyArgs, UsageError, USAGE } from './verify-args.mjs';

async function main() {
  let args;
  try {
    args = parseVerifyArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) { console.error(`error: ${e.message}\n${USAGE}`); return 2; }
    throw e;
  }
  const { backend } = await import('./backend.mjs');
  const {
    grpc, getPayable, getRegistryBalance, getTx, getBlockTime, SELLER, SELLER2, updatedEvent,
  } = await import('./chain-v2.mjs');
  const { REGISTRY } = await import('./config.mjs');
  const { verifyCcdV2, verifyPltV2 } = await import('./verifier-v2.mjs');

  const { payableId, txHash, docPath, rail: railArg, seller: sellerArg, reserve: reserveArg, confirm: confirmArg } = args;
  if (sellerArg && sellerArg !== SELLER && sellerArg !== SELLER2) {
    console.error('error: unknown --seller: expected the seller 1 or seller 2 address.\n' + USAGE);
    return 2;
  }
  const seller = sellerArg ?? SELLER;
  let docBytes = null;
  if (docPath) {
    try { docBytes = readFileSync(docPath); } catch { console.error(`error: cannot read the --doc file "${docPath}". Run from the api/ folder of the repository.`); return 2; }
  }
  const c = await grpc();
  let view;
  try {
    view = await getPayable(c, seller, payableId);
  } catch (e) {
    if (/payable view is None/.test(String(e?.message))) {
      console.error(`error: payable ${payableId} does not exist for seller ${seller}. ${seller === SELLER ? 'If it belongs to seller 2, add --seller <seller 2 address>.' : 'Check the payable number.'}`);
      return 3;
    }
    throw e;
  }
  // A checkout with CRLF line endings changes the document hash; the registered text is LF.
  if (docBytes && docBytes.includes(13)) {
    const sha = (b) => createHash('sha256').update(b).digest('hex');
    const lf = Buffer.from(docBytes.filter((b, i) => !(b === 13 && docBytes[i + 1] === 10)));
    if (sha(docBytes) !== String(view.docHash).toLowerCase() && sha(lf) === String(view.docHash).toLowerCase()) {
      docBytes = lf;
      console.log('NOTE the --doc file has CRLF line endings (a Windows checkout); it was hashed with LF endings, as registered.');
    }
  }
  const rail = railArg ?? (view.asset === 'CCD' ? 'ccd' : 'eudemo');
  const summary = await getTx(c, txHash);
  const blockTime = await getBlockTime(c, summary.blockHash);
  const balance = await getRegistryBalance(c);
  // PLT evidence (same shapes the server builds in pltEvidenceFor).
  async function evidence(hash, name) {
    if (!hash) return null;
    const { v2ev } = await backend();
    const st = await getTx(c, hash);
    const upd = updatedEvent(st, name);
    return { blockTime: await getBlockTime(c, st.blockHash), logged: upd ? v2ev.decodeLoggedEventsV2(upd) : [] };
  }
  const reserve = rail === 'eudemo' ? await evidence(reserveArg, 'reserve_plt') : null;
  const confirmEv = rail === 'eudemo' ? await evidence(confirmArg, 'confirm_plt') : null;
  const confirm = confirmEv ? { ...confirmEv, gen: 'v2' } : null;
  const result = rail === 'ccd'
    ? await verifyCcdV2(c, { payableId, txHash, summary, blockTime, view, balance, docBytes })
    // The registryIndex/gen pair is passed for interface stability only; the verifier reads no generation signal.
    : await verifyPltV2(c, { payableId, txHash, summary, blockTime, view, balance, docBytes, reserve, confirm, registryIndex: String(REGISTRY.index), gen: 'v2' });
  for (const ch of result.checks) {
    console.log(`${ch.status === 'ok' ? 'PASS' : ch.status === 'fail' ? 'FAIL' : ch.status.toUpperCase()} ${ch.id} ${ch.detail}`);
  }
  const notRun = result.checks.filter((ch) => ch.status === 'not_run').length;
  console.log(result.allPass
    ? (notRun ? `ALL RUNNABLE CHECKS PASS (${result.passed}/${result.total}; ${notRun} not run: add --doc <invoice file> for the document check${rail === 'eudemo' ? ', --reserve and --confirm for the EUDemo legs' : ''})` : `ALL CHECKS PASS (${result.passed}/${result.total})`)
    : `CHECKS FAILED (${result.passed}/${result.total} pass)`);
  return result.allPass ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => {
  const msg = String(e?.message ?? e).replace(/[0-9a-fA-F]{64}/g, (h) => `${h.slice(0, 8)}...`).split(/\r?\n/)[0].slice(0, 240);
  console.error(`error: could not finish the verification: ${msg}\nThe testnet node may be busy; run the command again.`);
  process.exit(3);
});
