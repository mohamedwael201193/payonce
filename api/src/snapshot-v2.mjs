// PayOnce API server — v2 co-signer snapshot builder (read-only chain reads).
// Mirrors backend src/v2/snapshot.mjs, but every view goes through the
// parameterized ./chain-v2.mjs layer (configured registry), so the v2.1
// switch is a config change. The snapshot is decide()-compatible
// (version 2, canonical memo payable:<seller>:<id>, payer = agent account).
// Chain time comes from the last finalized block, never the local clock.
import { backend } from './backend.mjs';
import { getPayable, getVendor, getUsage, agentOf, chainNow, getAccount, getTx, getBlockTime } from './chain-v2.mjs';

export async function buildSnapshotV2(c, opts) {
  const {
    seller, payableId, agentAccount, sponsorAccount = null,
    signatureThreshold = 1, blockHash = null,
    transferTxHash = null, reserveTxHash = null, usedTxHashes = [],
    memoScan = { found: false, txHash: null },
  } = opts;

  const now = await chainNow(c);
  const hash = blockHash ?? now.blockHash;
  const slotMs = now.slotMs;

  const view = await getPayable(c, seller, payableId, hash);
  const info = await getAccount(c, agentAccount, hash);
  const { chain } = await backend();
  const eudemoBalance = chain.tokenBalance(info, 'EUDemo');

  const approval = await getVendor(c, agentAccount, seller, hash);
  let usage = '0';
  if (approval) {
    const periodIndex = Math.floor(slotMs / 1000 / Number(approval.periodSecs));
    usage = await getUsage(c, agentAccount, seller, periodIndex, hash);
  }

  const agent = view.agentToken ? await agentOf(c, Number(view.agentToken)) : null;
  const agentStatus = agent ? agent.statusName : 'NotFound';

  let transfer = null;
  if (transferTxHash) {
    const summary = await getTx(c, transferTxHash);
    const tBlock = await getBlockTime(c, summary.blockHash);
    const t = (summary.summary?.events ?? []).find((e) => e.tag === 'TokenTransfer');
    const memoText = t ? chain.decodeCborMemo(t.memo ?? '').text : null;
    const canonical = `payable:${seller}:${payableId}`;
    const found = Boolean(
      t
      && t.from?.address === agentAccount
      && t.to?.address === view.payee
      && String(t.amount?.value ?? t.amount) === String(view.amount)
      && memoText === canonical,
    );
    transfer = {
      found,
      from: t?.from?.address ?? null,
      to: t?.to?.address ?? null,
      amount: t?.amount?.value ?? t?.amount ?? null,
      memo: memoText,
      blockTimeMs: String(new Date(tBlock.slotTime).getTime()),
    };
  }

  return {
    version: 2,
    blockHash: hash,
    slotTime: now.slotTime,
    agentAccount,
    sponsorAccount,
    signatureThreshold,
    nextNonce: Number(info.accountNonce),
    agentStatus,
    eudemoBalance,
    payable: {
      seller: view.seller,
      id: view.id,
      payee: view.payee,
      amount: view.amount,
      asset: view.asset,
      dueMs: view.dueMs,
      status: view.status,
      payer: view.record?.payer ?? null,
      expiresMs: view.record?.expiresMs ?? null,
      expectedPayer: view.expectedPayer,
      legalRef: view.legalRef,
    },
    approval,
    usage: String(usage),
    memoScan,
    usedTxHashes,
    transfer,
    // Extra (not part of decide()'s input contract): the reserve tx, so the
    // caller can verify the reservation window without a second fetch.
    ...(reserveTxHash ? { reserveTxHash } : {}),
  };
}
