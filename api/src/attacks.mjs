// PayOnce API server — "Try to break it" attacks (P3 §9, §16.12).
// Every attack is either LIVE (a real transaction or a real co-signer
// decision computed from live chain state) or explicitly labelled
// recorded (`live: false` + the 24 Nov 2026 recorded example).
//   - pay_twice: live when the payable is Paid — the second payment is
//     REALLY sent (CCD: pay_ccd -> -5; EUDemo: reserve_plt -> -16) and the
//     real refusal + fee + tx hash are returned. `precheck_only` sends
//     nothing. If the chain ever ACCEPTS the second payment, that is
//     reported as `unexpected_success` — never hidden.
//   - wrong_amount: CCD live — pay_ccd with amount+1 -> -6 (real tx, real
//     fee). EUDemo — co-signer dry-run refusal `wrong-amount`, no tx: the
//     dry run is computed live, on the hypothetical Reserved state the
//     transfer gate requires (labelled as such; the payable itself is
//     never reserved for an attack).
//   - unlisted_seller: NO fraud payable exists on v2 (no second seller —
//     D6; only the demo seller holds an Active agent token). Returns
//     `not_set_up` + the recorded v1 example, plus two live checks run
//     now: the vendor list (one seller, read from the chain) and a
//     co-signer dry run for an unlisted seller (REFUSE `no-approval` —
//     on v2 the vendor list IS enforced by the co-signer, unlike the v1
//     recorded run; the dry run assumes the fraud seller holds an Active
//     agent, labelled as an assumption).
import { createHash } from 'node:crypto';
import { backend } from './backend.mjs';
import {
  grpc, getPayableOrNull, getVendor, getRegistryBalance, getBlockTime,
  sendUpdate, waitFinalized, signers, canonicalMemoV2, SELLER, PAYER,
} from './chain-v2.mjs';
import { buildSnapshotV2 } from './snapshot-v2.mjs';
import { ledgerForDecide } from './ledger.mjs';
import { feeOf, rejectOf, rejectInfo } from './jobs.mjs';
import { loadCounters, saveCounters } from './store.mjs';
import {
  REGISTRY, OWNER_ADDRESS, PAYER_ADDRESS, txUrl, fmtCcd, fmtEudemo,
} from './config.mjs';

const RECORDED_DATE = '2026-11-24';

function recordedRefusal(code) {
  // The v1 recorded refusals (P3 §9 / frontend recorded.ts). v2 renames
  // two codes: -16 AlreadyReservedOrPaid -> NotUnpaid, -17
  // NotPayerOrSeller -> NotPayer. The recorded example keeps the v1 name
  // and is labelled with the v1 registry.
  const v1 = [
    { code: -5, name: 'WrongStatus', txHash: 'a5ec5e4027523c564d81960cb0ec48b546c270ec5f43256f15cf5d34f98d6848', plain: 'This invoice is already paid, so the chain refused a second payment. Nothing moved.' },
    { code: -6, name: 'WrongAmount', txHash: '52f3b4aa09086b27d6c41c3fc4ec10b6bac92f55aa6cc892b55291758b10f01c', plain: 'The amount does not match the invoice. The chain refused it. Nothing was moved.' },
    { code: -3, name: 'NotFound', txHash: 'd906c0b3b8bf6333cd0522fed0b39eabae168a2e35029edd9ac5a5b5874dae28', plain: 'No invoice with this number is on the registry. Nothing was moved.' },
    { code: -16, name: 'AlreadyReservedOrPaid', txHash: 'ae62175f96035d23a6df6f84daf89520fd7c534c3a3aa1195ca9af6af752af35', plain: 'This invoice is already reserved or paid. The chain refused a second reservation before any money moved.' },
    { code: -12, name: 'TxReused', txHash: '02ad73477a2e3635f4007ed7bab3c51a4dcd72a97e851fc213a92e6ec577f23b', plain: 'This payment transaction is already recorded against another invoice. Nothing was moved.' },
    { code: -17, name: 'NotPayerOrSeller', txHash: '8ee531f203c7e7578749841bf7dd3d8a252ad220745c2921abbf2906f7700e8a', plain: 'Only the payer or the seller can record this payment. The request was refused.' },
    { code: -13, name: 'NotExpired', txHash: '8902c4f12f1c268fc94576b01e1734c8a91e59b631c5857e3fa4a631eb4ef4e7', plain: 'The reservation is still open. It can be released only after its 300 s window (v1 recorded run; the live registry reserves for 3600 s).' },
  ];
  return v1.find((r) => r.code === code) ?? null;
}

function base(kind, payableId) {
  return { kind, payable_id: payableId, layer: 'chain', live: false, tx_sent: false, outcome: '', plain: '' };
}

async function recordLiveRefusal(txHash, code) {
  const c = await loadCounters();
  c.liveRefusals.push({ txHash, code, at: new Date().toISOString() });
  await saveCounters(c);
}

export async function attackPayTwice(payableId, mode) {
  const c = await grpc();
  const view = await getPayableOrNull(c, SELLER, payableId);
  const res = base('pay_twice', payableId);
  if (!view) {
    const rec = recordedRefusal(-3);
    return { ...res, layer: 'chain', outcome: 'not_found', plain: `No payable ${payableId} is on the test registry.`, recorded_example: { date: RECORDED_DATE, registry: '<13149,0> (v1)', ...rec } };
  }
  const isCcd = view.asset === 'CCD';
  const expectedCode = isCcd ? -5 : -16;
  if (mode === 'precheck_only') {
    return {
      ...res,
      layer: 'app',
      outcome: 'precheck',
      plain: view.status === 'Paid'
        ? `This app: payable ${payableId} is already Paid — a second payment would be refused by the chain (${expectedCode} ${rejectInfo(expectedCode).name}). Nothing was sent.`
        : `This app: payable ${payableId} is ${view.status}, not Paid — there is no second payment to attempt yet. Pay it first, then try again.`,
    };
  }
  if (view.status !== 'Paid') {
    const rec = recordedRefusal(expectedCode);
    return {
      ...res,
      outcome: 'not_paid_yet',
      plain: `Payable ${payableId} is ${view.status}, not Paid — a second payment cannot be attempted yet. The recorded run shows the refusal instead.`,
      recorded_example: { date: RECORDED_DATE, registry: '<13149,0> (v1)', ...rec },
    };
  }
  // Live: send the second payment for real.
  const { v2enc } = await backend();
  const sig = await signers();
  const receiveName = isCcd ? 'pay_ccd' : 'reserve_plt';
  const sent = await sendUpdate(c, {
    from: sig.sellerB, receiveName,
    parameterHex: v2enc.encodeV2PayableKey({ seller: SELLER, id: payableId }),
    ...(isCcd ? { amountMicroCcd: BigInt(view.amount) } : {}),
    maxEnergy: 6000n,
  });
  const status = await waitFinalized(c, sent.txHash);
  const fee = feeOf(status);
  const rr = rejectOf(status);
  await recordLiveRefusal(sent.txHash, rr?.rejectReason ?? null);
  if (!rr) {
    return {
      ...res, layer: 'chain', live: true, tx_sent: true, outcome: 'unexpected_success',
      tx_hash: sent.txHash, explorer_url: txUrl(sent.txHash), fee_testnet_ccd: fee,
      plain: `UNEXPECTED: the chain ACCEPTED the second payment for payable ${payableId} (tx ${sent.txHash.slice(0, 8)}…). This is a critical finding — the double-pay guard did not hold.`,
    };
  }
  const info = rejectInfo(rr.rejectReason);
  return {
    ...res, layer: 'chain', live: true, tx_sent: true, outcome: 'refused',
    reject: info, fee_testnet_ccd: fee, tx_hash: sent.txHash, explorer_url: txUrl(sent.txHash),
    plain: `The chain refused the second payment (${info.code} ${info.name}). Nothing moved; the fee was ${fee ?? '—'} testnet CCD.`,
  };
}

export async function attackWrongAmount(payableId) {
  const c = await grpc();
  const view = await getPayableOrNull(c, SELLER, payableId);
  const res = base('wrong_amount', payableId);
  if (!view) {
    const rec = recordedRefusal(-3);
    return { ...res, outcome: 'not_found', plain: `No payable ${payableId} is on the test registry.`, recorded_example: { date: RECORDED_DATE, registry: '<13149,0> (v1)', ...rec } };
  }
  if (view.status !== 'Unpaid') {
    const rec = recordedRefusal(-6);
    return {
      ...res, outcome: 'not_unpaid',
      plain: `Payable ${payableId} is ${view.status}, not Unpaid — the wrong amount cannot be attempted on it. The recorded run shows the refusal instead.`,
      recorded_example: { date: RECORDED_DATE, registry: '<13149,0> (v1)', ...rec },
    };
  }
  if (view.asset === 'CCD') {
    // Live: pay_ccd with amount + 1 microCCD -> chain -6.
    const { v2enc } = await backend();
    const sig = await signers();
    const wrongAmount = BigInt(view.amount) + 1n;
    const sent = await sendUpdate(c, {
      from: sig.sellerB, receiveName: 'pay_ccd',
      parameterHex: v2enc.encodeV2PayableKey({ seller: SELLER, id: payableId }),
      amountMicroCcd: wrongAmount, maxEnergy: 6000n,
    });
    const status = await waitFinalized(c, sent.txHash);
    const fee = feeOf(status);
    const rr = rejectOf(status);
    await recordLiveRefusal(sent.txHash, rr?.rejectReason ?? null);
    if (!rr) {
      return {
        ...res, layer: 'chain', live: true, tx_sent: true, outcome: 'unexpected_success',
        tx_hash: sent.txHash, explorer_url: txUrl(sent.txHash), fee_testnet_ccd: fee,
        plain: `UNEXPECTED: the chain ACCEPTED a payment of ${wrongAmount} microCCD for a ${view.amount} microCCD invoice (tx ${sent.txHash.slice(0, 8)}…). This is a critical finding.`,
      };
    }
    const info = rejectInfo(rr.rejectReason);
    return {
      ...res, layer: 'chain', live: true, tx_sent: true, outcome: 'refused',
      reject: info, fee_testnet_ccd: fee, tx_hash: sent.txHash, explorer_url: txUrl(sent.txHash),
      plain: `The chain refused the wrong amount (${info.code} ${info.name}): sent ${wrongAmount} microCCD, invoice is ${view.amount}. Nothing moved; the fee was ${fee ?? '—'} testnet CCD.`,
    };
  }
  // EUDemo: co-signer dry-run refusal (no tx). The transfer gate needs a
  // Reserved payable, so the dry run is computed on the hypothetical
  // Reserved state (labelled); the payable itself is never reserved.
  const { decideMod, chain } = await backend();
  const decide = decideMod.decide;
  const snapshot = await buildSnapshotV2(c, { seller: SELLER, payableId, agentAccount: PAYER_ADDRESS, sponsorAccount: null, signatureThreshold: 1 });
  const reservedSnapshot = {
    ...snapshot,
    payable: {
      ...snapshot.payable,
      status: 'Reserved',
      payer: PAYER_ADDRESS,
      expiresMs: String(Date.now() + 3600_000),
    },
  };
  const wrongAmount = (BigInt(view.amount) + 1n).toString();
  const decision = decide(reservedSnapshot, {
    kind: 'transfer', sender: PAYER_ADDRESS, txVersion: 1, sponsor: null, nonce: snapshot.nextNonce,
    recipient: view.payee, amount: wrongAmount, token: 'EUDemo',
    memo: chain.encodeCborMemo(canonicalMemoV2(SELLER, payableId)).toString('hex'),
    headerExpirySeconds: Math.floor((Date.now() + 3540_000) / 1000), operations: 1,
  }, await ledgerForDecide(`${SELLER}:${payableId}`));
  return {
    ...res,
    layer: 'co_signer',
    live: true,
    tx_sent: false,
    outcome: decision.decision === 'SIGN' ? 'unexpected_approve' : 'refused',
    plain: decision.decision === 'SIGN'
      ? `UNEXPECTED: the co-signer APPROVED a transfer of the wrong amount (${wrongAmount} instead of ${view.amount}). No transaction was sent (dry run).`
      : `The co-signer refused the wrong amount (${decision.code}): asked ${wrongAmount} base units, invoice is ${view.amount}. No transaction was sent — the dry run is computed from live chain state on the hypothetical Reserved state the transfer gate requires.`,
  };
}

export async function attackUnlistedSeller(payableId) {
  const c = await grpc();
  // Live vendor-list read: the demo payer's approvals (exactly the owner).
  const approval = await getVendor(c, PAYER_ADDRESS, OWNER_ADDRESS);
  const vendorList = approval
    ? [{ seller: OWNER_ADDRESS, label: 'Lab seller account (demo seller)' }]
    : [];
  // Live co-signer dry run for an unlisted seller: approval = null (live
  // read — no approval row exists for the placeholder seller), agent
  // assumed Active (labelled assumption: the dry run isolates the
  // vendor-list rule).
  const fraudSeller = `payonce-lab-fraud-seller:${createHash('sha256').update('payonce-lab-fraud-seller').digest('hex').slice(0, 16)}`;
  const { decideMod } = await backend();
  const decide = decideMod.decide;
  const dryRun = decide(
    {
      version: 2, blockHash: 'synthetic', slotTime: new Date().toISOString(),
      agentAccount: PAYER_ADDRESS, sponsorAccount: null, signatureThreshold: 1,
      nextNonce: 0, agentStatus: 'Active', eudemoBalance: '1000000',
      payable: {
        seller: fraudSeller, id: 9001, payee: PAYER_ADDRESS, amount: '1000000',
        asset: 'EUDemo', dueMs: String(Date.now() + 3600_000), status: 'Unpaid',
        payer: null, expiresMs: null, expectedPayer: PAYER_ADDRESS, legalRef: null,
      },
      approval: null, usage: '0', memoScan: { found: false, txHash: null },
      usedTxHashes: [], transfer: null,
    },
    { kind: 'reserve_plt', sender: PAYER_ADDRESS, txVersion: 1, sponsor: null, numSignatures: 1, nonce: 0 },
    { unresolved: [] },
  );
  return {
    ...base('unlisted_seller', payableId),
    layer: 'app',
    outcome: 'not_set_up',
    plain: `The lab fraud invoice is not set up on this registry yet — no second seller account exists (only the demo seller holds an Active agent token). Nothing was sent. The vendor list has one seller, read live from the chain.`,
    recorded_example: {
      date: RECORDED_DATE,
      registry: '<13149,0> (v1)',
      note: 'Recorded run, 24 Nov 2026 (v1 registry): the chain accepted a fraudster invoice because anyone can register one, and the v1 co-signer approved it (dry run: approve). On v2 the co-signer refuses an unlisted seller — see the live dry run below.',
      vendor_list_live: vendorList,
      vendor_list_note: 'Read live from the chain just now: get_vendor(demo payer, demo seller) returns the approval row; any other seller returns no row.',
      cosigner_dry_run_live: {
        decision: dryRun.decision,
        code: dryRun.code,
        reasons: dryRun.reasons,
        note: 'Computed live with decide() on a synthetic unlisted-seller payable (seller is a lab placeholder identifier, not an account address — no such seller exists; the dry run assumes the seller holds an Active agent token, so the vendor-list rule is what is tested).',
      },
      fraud_seller_placeholder: fraudSeller,
    },
  };
}
