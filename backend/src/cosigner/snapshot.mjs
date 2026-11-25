// PayOnce backend — co-signer snapshot builder (read-only chain reads).
// A snapshot is the decide() input taken at ONE finalized block. Everything
// the chain can say is read from the chain: payable row, block time, the
// agent's next nonce, the agent's EUDemo balance.
// OPERATOR INPUTS (not chain-read, documented as v2 gaps):
//   - agentStatus: the registry getAgent view is not decoded yet, so the
//     operator supplies it; decide() refuses unless it is exactly 'Active',
//     so an unknown status fails closed. (Registry view decode = open work.)
//   - approval / usage: the v1 registry has no vendor approvals; the v2
//     approval row is a policy input until the v2 contract ships.
//   - memoScan / usedTxHashes: maintained by the operator from the ledger
//     and from finalized transfers (see recheck.mjs).
//   - transfer: if transferTxHash is given, the transfer is verified with the
//     PLT verifier (verifyPlt) and the result is recorded in the snapshot.
import { getBlockTime, getAccountInfo, tokenBalance } from '../chain.mjs';
import { getPayable } from '../registry.mjs';
import { verifyPltTransfer } from '../verifier/checks.mjs';

export async function buildSnapshot(client, opts) {
  const {
    payableId, agentAccount, sponsorAccount, version = 1, blockHash,
    approval = null, usage = '0', memoScan = { found: false, txHash: null },
    usedTxHashes = [], agentStatus = 'Active', transferTxHash = null,
    confirmTxHash = null,
  } = opts;

  const block = blockHash
    ? await getBlockTime(client, blockHash)
    : await (async () => {
        const { toJson } = await import('../chain.mjs');
        const consensus = toJson(await client.getConsensusStatus());
        const hash = consensus.lastFinalizedBlock;
        const info = await getBlockTime(client, hash);
        return { ...info, blockHash: hash };
      })();
  const hash = blockHash ?? block.blockHash;

  const view = await getPayable(client, payableId, undefined, hash);
  const info = await getAccountInfo(client, agentAccount, hash);
  const eudemoBalance = tokenBalance(info, 'EUDemo');

  let transfer = null;
  if (transferTxHash) {
    const { getTxStatus, getBlockTime: gbt, decodeCborMemo } = await import('../chain.mjs');
    const { decodeLoggedEvents } = await import('../events.mjs');
    const summary = await getTxStatus(client, transferTxHash);
    const tBlock = await gbt(client, summary.blockHash);
    let reserve = null;
    if (opts.reserveTxHash) {
      const rs = await getTxStatus(client, opts.reserveTxHash);
      const rbt = await gbt(client, rs.blockHash);
      const upd = (rs.summary?.events ?? []).find(
        (e) => e.tag === 'Updated' && String(e.address?.index) === '13149' && e.receiveName === 'payable_registry.reserve_plt',
      );
      // G7 fix-back-3 MF-1: the reserve seek is v1-only, so the reserve
      // carries registryIndex '13149' (from the found event) and the
      // view is the v1 view — the binding below is real, not assumed.
      reserve = { blockTime: rbt, logged: upd ? decodeLoggedEvents(upd) : [], registryIndex: String(upd?.address?.index ?? '13149') };
    }
    // G7 fix-back-3 MF-1: requireReserve:true — a confirm-gate snapshot
    // with no reserve evidence must NOT verify the transfer (PLT-13
    // FAILS instead of SKIP). No behaviour change for the MCP confirm
    // gate, which always supplies reserveTxHash; any future caller that
    // omits it now fails closed (decide() refuses transfer-not-verified).
    const result = verifyPltTransfer({
      payableId, txHash: transferTxHash, summary, blockTime: tBlock, view,
      reserve, requireReserve: true, registryIndex: '13149',
    });
    const t = (summary.summary?.events ?? []).find((e) => e.tag === 'TokenTransfer');
    transfer = {
      found: result.allPass,
      from: t?.from?.address ?? null,
      to: t?.to?.address ?? null,
      amount: t?.amount?.value ?? null,
      memo: t ? decodeCborMemo(t.memo ?? '').text : null,
      blockTimeMs: String(new Date(tBlock.slotTime).getTime()),
    };
  }

  return {
    version,
    blockHash: hash,
    slotTime: block.slotTime,
    agentAccount,
    sponsorAccount,
    signatureThreshold: opts.signatureThreshold ?? 2,
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
      expectedPayer: agentAccount,
      legalRef: null,
    },
    approval,
    usage: String(usage),
    memoScan,
    usedTxHashes,
    transfer,
    confirmTxHash,
  };
}
