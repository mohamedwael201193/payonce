// Pure argument parsing for the keyless verifier CLI (verify-payable-v2.mjs). Kept free of any
// chain or SDK import so the command shapes the UI prints can be parsed and tested offline.
export class UsageError extends Error {}

const HASH = /^[0-9a-fA-F]{64}$/;
export const USAGE =
  'usage: node src/verify-payable-v2.mjs <payable-id> <tx-hash> [--seller <address>] [--rail ccd|eudemo] [--doc <path>] [--reserve <tx-hash>] [--confirm <tx-hash>]\n' +
  '  <tx-hash> is the pay_ccd transaction (CCD rail) or the EUDemo transfer transaction (EUDemo rail).\n' +
  '  Seller 2 payables need --seller <address>. EUDemo payables need --reserve and --confirm for the full check.';

/** @returns {{payableId:number, txHash:string, docPath:string|null, rail:string|null, seller:string|null, reserve:string|null, confirm:string|null}} */
export function parseVerifyArgs(argv) {
  const [idArg, txArg, ...rest] = argv;
  const payableId = Number(idArg);
  if (!Number.isInteger(payableId) || payableId < 1) throw new UsageError(`"${idArg ?? ''}" is not a payable number.`);
  if (!HASH.test(txArg ?? '')) throw new UsageError('the second argument must be a 64-character transaction hash.');
  const out = { payableId, txHash: txArg.toLowerCase(), docPath: null, rail: null, seller: null, reserve: null, confirm: null };
  const flags = { '--doc': 'docPath', '--rail': 'rail', '--seller': 'seller', '--reserve': 'reserve', '--confirm': 'confirm' };
  for (let i = 0; i < rest.length; i += 1) {
    const key = flags[rest[i]];
    if (!key) throw new UsageError(`unknown option ${rest[i]}.`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${rest[i]} needs a value.`);
    out[key] = value;
    i += 1;
  }
  if (out.rail && !['ccd', 'eudemo'].includes(out.rail)) throw new UsageError('--rail must be ccd or eudemo.');
  for (const k of ['reserve', 'confirm']) {
    if (out[k] && !HASH.test(out[k])) throw new UsageError(`--${k} must be a 64-character transaction hash.`);
    if (out[k]) out[k] = out[k].toLowerCase();
  }
  return out;
}
