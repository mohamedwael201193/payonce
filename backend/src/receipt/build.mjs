// PayOnce backend — walletless receipt builder (EU AI Act Art. 12 record).
// Read-only, testnet only: no signer, no key, no env file, no sends.
// buildReceipt() reads the chain live (view, tx statuses, block times,
// registry balance), runs the keyless verifier, and FAILS (throws, no
// receipt) unless every check passes. The receipt is a hash-anchored
// Art. 12 record in the registerData style (workshops W3–W6, §7.3–7.4):
// the record itself carries a random nonce and a recordHash = sha256 of
// the canonical receipt JSON (without recordHash); no PII goes on chain.
import { createHash, randomBytes } from 'node:crypto';
import { grpcClient, getTxStatus, getBlockTime } from '../chain.mjs';
import { getPayable, getRegistryBalance } from '../registry.mjs';
import { decodeLoggedEvents } from '../events.mjs';
import { verifyCcd, verifyPlt } from '../verifier/checks.mjs';

export const REGISTRY = '<13149,0>';
export const NETWORK = 'testnet';
export const FOOTER =
  'Testnet receipt. It is not a legal invoice, a tax document or proof of delivery.';

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Canonical JSON: object keys sorted recursively, so recordHash is stable. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** Deterministic receipt id: sha256 of "payableId:paymentTxHash". */
export function receiptIdFor(payableId, paymentTxHash) {
  return sha256Hex(`${Number(payableId)}:${paymentTxHash.toLowerCase()}`);
}

export function computeRecordHash(receiptWithoutRecordHash) {
  return sha256Hex(canonicalJson(receiptWithoutRecordHash));
}

function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

/**
 * Build a receipt for a Paid payable, verified live from chain alone.
 * @param {object} args
 * @param {number} args.payableId
 * @param {string} args.registerTx - register_* tx hash
 * @param {string} [args.payTx] - CCD pay_ccd tx hash
 * @param {string} [args.reserveTx] - PLT reserve_plt tx hash
 * @param {string} [args.transferTx] - PLT TokenTransfer tx hash
 * @param {string} [args.confirmTx] - PLT confirm_plt tx hash
 * @param {Buffer} args.docBytes - invoice document bytes
 * @throws when the payable is not Paid, a required tx hash is missing or
 *   not finalized, or the verifier does not fully pass.
 */
export async function buildReceipt(args) {
  const { payableId, registerTx, payTx, reserveTx, transferTx, confirmTx, docBytes } = args ?? {};
  if (!Number.isInteger(payableId) || payableId < 0) throw new Error('buildReceipt: payableId must be a non-negative integer');
  if (!Buffer.isBuffer(docBytes) || docBytes.length === 0) throw new Error('buildReceipt: docBytes (invoice document) is required');
  if (!isHex64(registerTx)) throw new Error('buildReceipt: registerTx (64 hex chars) is required');

  const client = grpcClient();
  // 1. Live view first: only a Paid payable can have a receipt.
  const view = await getPayable(client, payableId);
  if (view.status !== 'Paid') {
    throw new Error(`buildReceipt: payable ${payableId} is ${view.status}, not Paid — no receipt`);
  }
  const isCcd = view.asset === 'CCD';
  const paymentTx = isCcd ? payTx : transferTx;
  if (isCcd && !isHex64(payTx)) throw new Error('buildReceipt: payTx (64 hex chars) is required for a CCD payable');
  if (!isCcd) {
    if (!isHex64(transferTx)) throw new Error('buildReceipt: transferTx (64 hex chars) is required for a PLT payable');
    if (!isHex64(reserveTx)) throw new Error('buildReceipt: reserveTx (64 hex chars) is required for a PLT payable');
    if (!isHex64(confirmTx)) throw new Error('buildReceipt: confirmTx (64 hex chars) is required for a PLT payable');
  }

  // 2. Live tx statuses + block times + registry balance.
  const regSummary = await getTxStatus(client, registerTx.toLowerCase());
  if (regSummary.status !== 'finalized') throw new Error(`buildReceipt: register tx ${registerTx} is ${regSummary.status}, not finalized`);
  const regBlockTime = await getBlockTime(client, regSummary.blockHash);
  const paySummary = await getTxStatus(client, paymentTx.toLowerCase());
  const payBlockTime = await getBlockTime(client, paySummary.blockHash);
  const balance = await getRegistryBalance(client);

  const ctx = { payableId, txHash: paymentTx.toLowerCase(), summary: paySummary, blockTime: payBlockTime, view, balance, docBytes };
  const blockTimes = { register: regBlockTime.slotTime };
  let result;
  if (isCcd) {
    blockTimes.pay = payBlockTime.slotTime;
    result = verifyCcd(ctx);
  } else {
    const rs = await getTxStatus(client, reserveTx.toLowerCase());
    const rbt = await getBlockTime(client, rs.blockHash);
    const upd = (rs.summary?.events ?? []).find(
      (e) => e.tag === 'Updated' && String(e.address?.index) === '13149' && e.receiveName === 'payable_registry.reserve_plt',
    );
    ctx.reserve = { blockTime: rbt, logged: upd ? decodeLoggedEvents(upd) : [] };
    const cs = await getTxStatus(client, confirmTx.toLowerCase());
    const cbt = await getBlockTime(client, cs.blockHash);
    ctx.confirm = { blockTime: cbt };
    blockTimes.reserve = rbt.slotTime;
    blockTimes.transfer = payBlockTime.slotTime;
    blockTimes.confirm = cbt.slotTime;
    result = verifyPlt(ctx);
  }

  // 3. Fail closed: no receipt unless every check passes.
  if (!result.allPass) {
    const failed = result.checks.filter((c) => c.status === 'FAIL').map((c) => c.id).join(', ');
    throw new Error(`buildReceipt: verifier did not fully pass for payable ${payableId} (${result.passed}/${result.total} passed; failed: ${failed})`);
  }

  // 4. Assemble the Art. 12 record.
  const receipt = {
    receiptId: receiptIdFor(payableId, paymentTx),
    payableId,
    seller: view.seller,
    payer: view.record.payer,
    payee: view.payee,
    amount: view.amount,
    asset: view.asset,
    due: view.due,
    docHash: sha256Hex(docBytes),
    registerTx: registerTx.toLowerCase(),
    ...(isCcd
      ? { payTx: paymentTx.toLowerCase() }
      : {
          reserveTx: reserveTx.toLowerCase(),
          transferTx: paymentTx.toLowerCase(),
          confirmTx: confirmTx.toLowerCase(),
        }),
    blockTimes,
    paidAt: view.record.paidAt,
    verifier: {
      checks: result.checks,
      passed: result.passed,
      failed: result.failed,
      skipped: result.skipped,
      total: result.total,
      allPass: result.allPass,
    },
    nonce: randomBytes(16).toString('hex'),
    issuedAt: new Date().toISOString(),
    network: NETWORK,
    registry: REGISTRY,
    footer: FOOTER,
  };
  receipt.recordHash = computeRecordHash(receipt);
  return receipt;
}
