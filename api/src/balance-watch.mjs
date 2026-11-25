// PayOnce API — balance watch + top-up (workshops W3 §6.4, Doris's 4th
// sponsor safeguard; W-31). The first three safeguards were DONE long ago
// (decide() checks before signing; keys from env only; rate limits live).
// The fourth — "watch the balance / top-up behind the scenes" — was only
// PARTIAL: /api/health reported sponsor/payer status, but nothing watched
// it continuously and no top-up path existed. This module is the watch:
// balances for payer (seller B), sponsor (owner) and the EUDemo wallet,
// against the same ok/low/empty bands /api/health uses, plus a top-up
// (owner -> payer plain CCD transfer, in-process owner signer, testnet
// only) that the operator runs when the watch says `low`.
//
// Thresholds (microCCD): ok >= 50 CCD (one worst-case 6000-NRG send is
// ~47 CCD, so 50 covers one send plus margin — same headroom the verifier
// uses), low > 0, empty == 0. The watch never sends anything itself; it
// only reports. Top-up is an explicit operator call, recorded with its tx
// hash. No auto-top-up runs on the server (deliberate: an automatic
// drain of the owner account is worse than a manual top-up).
import { AccountAddress, Transaction, TransactionExpiry, CcdAmount, SequenceNumber } from '@concordium/web-sdk';
import { OWNER_ADDRESS, PAYER_ADDRESS, PAYEE_EUDEMO, txUrl } from './config.mjs';
import { getAccount, microCcdOf, grpc, nextNonce } from './chain-v2.mjs';

export const BALANCE_OK_MICROCCD = 50_000_000n; // 50 CCD
export const BALANCE_WATCH = {
  payer: PAYER_ADDRESS,
  sponsor: OWNER_ADDRESS,
  eudemoWallet: PAYEE_EUDEMO,
};

export function balanceStatus(availableMicroCcd) {
  const v = BigInt(availableMicroCcd ?? 0);
  if (v >= BALANCE_OK_MICROCCD) return 'ok';
  if (v > 0n) return 'low';
  return 'empty';
}

/** Read the watched balances live. Read-only; returns plain JSON. */
export async function checkBalances(client = null) {
  const c = client ?? (await grpc());
  const out = { network: 'testnet', checkedAt: new Date().toISOString(), accounts: {} };
  for (const [role, address] of Object.entries(BALANCE_WATCH)) {
    try {
      const info = await getAccount(c, address);
      const ccdMicro = BigInt(microCcdOf(info.accountAvailableBalance ?? info.accountAmount));
      // PLT balances live in account state; EUDemo is the watched token.
      let eudemo = null;
      try {
        const { backend } = await import('./backend.mjs');
        const { chain } = await backend();
        eudemo = chain.tokenBalance(info, 'EUDemo');
      } catch { /* token read is best-effort */ }
      out.accounts[role] = {
        address,
        ccd: (Number(ccdMicro) / 1e6).toFixed(6),
        ccd_micro: ccdMicro.toString(),
        status: balanceStatus(ccdMicro),
        eudemo_base: eudemo,
      };
    } catch (e) {
      out.accounts[role] = { address, status: 'unknown', error: String(e?.message ?? e).slice(0, 200) };
    }
  }
  const worst = Object.values(out.accounts).map((a) => a.status);
  out.overall = worst.includes('empty') ? 'empty' : worst.includes('low') ? 'low' : worst.includes('unknown') ? 'unknown' : 'ok';
  out.action = out.overall === 'ok'
    ? 'none — all watched balances cover at least one worst-case send'
    : 'top-up the low/empty account (owner -> payer; see POST /api/balance-watch/top-up) before the next live run';
  return out;
}

/**
 * Top-up the payer (seller B) from the owner account: a plain CCD
 * transfer, owner-signed in-process. Testnet only. Returns the tx hash +
 * explorer URL. The caller decides the amount; the module refuses
 * absurd amounts (> 1,000 CCD) and non-positive amounts.
 */
export async function topUpPayer({ grpcClient, signers, amountMicroCcd }) {
  const amount = BigInt(amountMicroCcd);
  if (amount <= 0n) throw new Error('topUpPayer: amount must be positive');
  if (amount > 1_000_000_000n) throw new Error('topUpPayer: amount over the 1,000 CCD safety cap — split it or pass it explicitly');
  const { owner } = await signers();
  const client = grpcClient;
  // Same dual-copy boundary as buyer-agent: nonce via the string-address
  // helper, never client.getAccountInfo with this file's AccountAddress.
  const nonce = await nextNonce(client, owner.address);
  const tx = Transaction.transfer({
    to: AccountAddress.fromBase58(PAYER_ADDRESS),
    amount: CcdAmount.fromMicroCcd(amount),
  }).addMetadata({
    sender: AccountAddress.fromBase58(owner.address),
    nonce: SequenceNumber.create(nonce),
    expiry: TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
  });
  const finalized = await Transaction.signAndFinalize(tx.build(), owner.signer);
  const hash = await client.sendTransaction(finalized);
  const txHash = typeof hash === 'string' ? hash : Buffer.from(hash.buffer ?? hash).toString('hex');
  return { from: owner.address, to: PAYER_ADDRESS, amount_micro_ccd: amount.toString(), tx_hash: txHash.toLowerCase(), explorer_url: txUrl(txHash.toLowerCase()) };
}
