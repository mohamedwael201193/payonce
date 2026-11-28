// Real chain adapter for dash.mjs on a v3 book: server-signed updates (hash known before sending), status, previews.
import {
  AccountAddress, ContractAddress, ReceiveName, Parameter, CcdAmount, Energy, TransactionExpiry, Transaction, Payload, TransactionHash,
} from '@concordium/web-sdk';
import { getPayeeRecord, getPayableV3, getConfigV3 } from './vop-chain.mjs';

const J = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
function outcomeOf(summary) {
  const s = J(summary ?? {});
  const rr = s.rejectReason?.rejectReason ?? s.rejectReason?.contents?.rejectReason ?? null;
  return { ok: !s.rejectReason, reject: rr != null ? Number(rr) : null };
}

/** deps: { client(), signers() -> { owner, seller2 }, book, seller, walletProxy? } */
export function createDashChain(deps) {
  const { book } = deps;
  const role = async (r) => { const s = await deps.signers(); return r === 'seller' ? s.owner : s.seller2; };
  const contract = () => ContractAddress.create(book.index, book.subindex);
  const wp = deps.walletProxy ?? 'https://wallet-proxy.testnet.concordium.com';

  return {
    async sign(r, entrypoint, paramHex, amountMicro, energy) {
      const c = deps.client(); const s = await role(r);
      const next = await c.getNextAccountNonce(AccountAddress.fromBase58(s.address));
      const expiry = TransactionExpiry.futureMinutes(5);
      const tx = Transaction.updateContract(Payload.updateContract({
        amount: CcdAmount.fromMicroCcd(BigInt(amountMicro ?? 0)), address: contract(),
        receiveName: ReceiveName.fromString(`${book.name}.${entrypoint}`), message: Parameter.fromHexString(paramHex),
      }), Energy.create(BigInt(energy))).addMetadata({ sender: AccountAddress.fromBase58(s.address), nonce: next.nonce, expiry }).build();
      const fin = await Transaction.signAndFinalize(tx, s.signer);
      const hash = Buffer.from(Transaction.getAccountTransactionHash(fin)).toString('hex');
      return { hash, expiry_ms: Number(expiry.expiryEpochSeconds) * 1000, submit: () => c.sendTransaction(fin) };
    },
    async status(hash) {
      try {
        const st = await deps.client().getBlockItemStatus(TransactionHash.fromHexString(hash));
        if (st?.status === 'finalized') return { state: 'finalized', ...outcomeOf(st.outcome?.summary) };
        return { state: 'pending' };
      } catch (e) {
        if (/not.?found|NOT_FOUND/i.test(String(e?.message ?? e)) || Number(e?.code) === 5) return { state: 'absent' };
        throw e;
      }
    },
    async wait(hash, ms) {
      try {
        const s = await deps.client().waitForTransactionFinalization(TransactionHash.fromHexString(hash), ms);
        return outcomeOf(s?.summary);
      } catch (e) {
        if (/timed? ?out|timeout|deadline/i.test(String(e?.message ?? e))) return null;
        throw e;
      }
    },
    async preview(invoker, entrypoint, paramHex, amountMicro) {
      const res = await deps.client().invokeContract({
        invoker: AccountAddress.fromBase58(invoker), contract: contract(), method: ReceiveName.fromString(`${book.name}.${entrypoint}`),
        parameter: Parameter.fromHexString(paramHex), amount: CcdAmount.fromMicroCcd(BigInt(amountMicro ?? 0)),
      });
      const used = BigInt(res.usedEnergy?.value ?? res.usedEnergy ?? 0);
      if (res.tag === 'success') return { ok: true, reject: null, used };
      const code = res.reason?.rejectReason ?? res.reason?.contents?.rejectReason;
      return { ok: false, reject: code != null ? Number(code) : null, used };
    },
    getPayee: (payee) => getPayeeRecord(deps.client(), deps.seller, payee, book),
    getPayable: (id) => getPayableV3(deps.client(), deps.seller, id, book),
    config: () => getConfigV3(deps.client(), book),
    async balance(address) {
      const i = J(await deps.client().getAccountInfo(AccountAddress.fromBase58(address)));
      return BigInt(i.accountAvailableBalance?.microCcdAmount ?? i.accountAvailableBalance ?? i.accountAmount?.microCcdAmount ?? i.accountAmount ?? 0);
    },
    notSent: (e) => /duplicate nonce|DuplicateNonce|nonce too/i.test(String(e?.message ?? e)),
    /** best effort: the payer's own pay_ccd to this book finalized at the payable's paid time (wallet-proxy) */
    async findPayTx(payer, paidAtMs) {
      const r = await fetch(`${wp}/v1/accTransactions/${payer}?limit=30&order=descending`).then((x) => x.json());
      const t = (r.transactions ?? []).find((x) => x.details?.type === 'update' && x.details?.outcome === 'success' && Math.abs(Number(x.blockTime) * 1000 - Number(paidAtMs)) < 15_000);
      return t?.transactionHash ?? null;
    },
  };
}
