// PayOnce backend — walletless receipt CLI (testnet only, read-only).
//   node src/receipt/cli.mjs build <payableId> --doc <path> --out <path>
//       [--register-tx <hash>] [--pay-tx <hash>]
//       [--reserve-tx <hash>] [--transfer-tx <hash>] [--confirm-tx <hash>]
//   node src/receipt/cli.mjs verify <receipt.json> --doc <path>
// Tx hashes may be omitted for payables recorded in the live e2e proof
// (test/live-e2e-2026-11-24.json); explicit flags always win.
// Prints a short human verdict; exits non-zero on failure.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildReceipt } from './build.mjs';
import { verifyReceipt } from './verify.mjs';

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function usage() {
  console.log('Usage:');
  console.log('  node src/receipt/cli.mjs build <payableId> --doc <path> --out <path> [--register-tx <hash>] [--pay-tx <hash>] [--reserve-tx <hash>] [--transfer-tx <hash>] [--confirm-tx <hash>]');
  console.log('  node src/receipt/cli.mjs verify <receipt.json> --doc <path>');
  process.exit(2);
}

const args = process.argv.slice(2);
const cmd = args[0];
const positional = args.filter((a) => !a.startsWith('--'));
const opt = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

/** Tx hashes recorded in the live e2e proof file (payables 6 and 7). */
function proofHashes(payableId) {
  const p = join(BACKEND_DIR, 'test', 'live-e2e-2026-11-24.json');
  if (!existsSync(p)) return {};
  const proof = JSON.parse(readFileSync(p, 'utf8'));
  if (payableId === 6) return { registerTx: proof.railA.registerTx, payTx: proof.railA.payTx };
  if (payableId === 7) {
    return {
      registerTx: proof.railB.registerTx,
      reserveTx: proof.railB.reserveTx,
      transferTx: proof.railB.transferTx,
      confirmTx: proof.railB.confirmTx,
    };
  }
  return {};
}

function verdictLine(result) {
  const passed = result.checks.filter((c) => c.status === 'PASS').length;
  return `${passed}/${result.checks.length} checks passed`;
}

try {
  if (cmd === 'build') {
    const payableId = Number(positional[1]);
    const docPath = opt('--doc');
    const outPath = opt('--out');
    if (!Number.isInteger(payableId) || payableId < 0 || !docPath || !outPath) usage();
    const docBytes = readFileSync(docPath);
    const known = proofHashes(payableId);
    const receipt = await buildReceipt({
      payableId,
      registerTx: opt('--register-tx') ?? known.registerTx,
      payTx: opt('--pay-tx') ?? known.payTx,
      reserveTx: opt('--reserve-tx') ?? known.reserveTx,
      transferTx: opt('--transfer-tx') ?? known.transferTx,
      confirmTx: opt('--confirm-tx') ?? known.confirmTx,
      docBytes,
    });
    writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`Receipt built for payable ${payableId} (${receipt.asset}) — ${verdictLine(receipt.verifier)}`);
    console.log(`  receiptId: ${receipt.receiptId}`);
    console.log(`  recordHash: ${receipt.recordHash}`);
    console.log(`  written to ${outPath}`);
    process.exit(0);
  }

  if (cmd === 'verify') {
    const receiptPath = positional[1];
    const docPath = opt('--doc');
    if (!receiptPath || !docPath) usage();
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const docBytes = readFileSync(docPath);
    const result = await verifyReceipt(receipt, { docBytes });
    for (const c of result.checks) {
      console.log(`  [${c.status}] ${c.id} ${c.name} — ${c.detail}`);
    }
    if (result.allPass) {
      console.log(`RECEIPT VERIFIED — payable ${receipt.payableId} (${receipt.asset}), ${verdictLine(result)}`);
      process.exit(0);
    } else {
      console.log(`RECEIPT FAILED — payable ${receipt.payableId}, ${result.failures.length} failure(s): ${result.failures.map((f) => f.id).join(', ')}`);
      process.exit(1);
    }
  }

  usage();
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}
