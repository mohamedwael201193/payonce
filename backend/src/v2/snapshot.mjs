// PayOnce backend — v2 co-signer snapshot builder (read-only chain reads).
// Same contract as src/cosigner/snapshot.mjs, but for the v2 registry:
// the payable is keyed by (seller, id), the approval row and the usage
// counter are READ from the chain (get_vendor / get_usage — the v1 gaps
// are closed on v2), and the agent status is READ via agentOf on the
// official registry (no operator-supplied status).
// The snapshot is decide()-compatible with version: 2, so the canonical
// memo is payable:<seller>:<id> (D1) and the payer is the agent account.
// memoScan is operator-maintained (the contract's used_tx set is the
// authoritative on-chain reuse guard, -12); usedTxHashes likewise.
import { getBlockTime, getAccountInfo, tokenBalance, decodeCborMemo, getTxStatus, toJson } from '../chain.mjs';
import { getPayableV2, getVendorV2, getUsageV2, agentOf } from './registry.mjs';

export async function buildSnapshotV2(client, opts) {
  const {
    seller, payableId, agentAccount, sponsorAccount = null,
    signatureThreshold = 1, blockHash = null,
    transferTxHash = null, usedTxHashes = [],
    memoScan = { found: false, txHash: null },
  } = opts;

  const block = blockHash
    ? { ...(await getBlockTime(client, blockHash)), blockHash }
    : await (async () => {
        const consensus = toJson(await client.getConsensusStatus());
        const hash = consensus.lastFinalizedBlock;
        return { ...(await getBlockTime(client, hash)), blockHash: hash };
      })();
  const hash = block.blockHash;
  const slotMs = new Date(block.slotTime).getTime();

  const view = await getPayableV2(client, seller, payableId, hash);
  const info = await getAccountInfo(client, agentAccount, hash);
  const eudemoBalance = tokenBalance(info, 'EUDemo');

  // Approval + usage are chain-read on v2.
  const approval = await getVendorV2(client, agentAccount, seller, hash);
  let usage = '0';
  if (approval) {
    const periodIndex = Math.floor(slotMs / 1000 / Number(approval.periodSecs));
    usage = await getUsageV2(client, agentAccount, seller, periodIndex, hash);
  }

  // Agent status is chain-read via agentOf on the official registry.
  const agent = view.agentToken ? await agentOf(client, Number(view.agentToken)) : null;
  const agentStatus = agent ? agent.statusName : 'NotFound';

  // Transfer verification for the confirm gate: the TokenTransfer event in
  // the transfer tx must match the payable (sender, payee, amount, memo).
  let transfer = null;
  if (transferTxHash) {
    const summary = await getTxStatus(client, transferTxHash);
    const tBlock = await getBlockTime(client, summary.blockHash);
    const t = (summary.summary?.events ?? []).find((e) => e.tag === 'TokenTransfer');
    const memoText = t ? decodeCborMemo(t.memo ?? '').text : null;
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
    slotTime: block.slotTime,
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
  };
}
