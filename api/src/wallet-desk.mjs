// PayOnce API - the "use your own wallet" desk: what a first-time visitor with a Concordium wallet needs.
//   account(addr)            balance + "needs test CCD?"
//   faucet(addr)             a one-time 2 CCD testnet starter drop (rate limited, never to a funded account)
//   invoiceFor(payer)        seller 1 registers a small CCD invoice whose expected_payer is the visitor's account
//   payTransaction(s,id,a)   the exact pay_ccd transaction the visitor's wallet signs (amount, JSON, schema)
// Pure decisions over injected adapters; open-wiring/server provide the real chain. Testnet only.
import { OpenError, isAddress, microToCcd } from './open-sellers.mjs';

export const DESK_POLICY = Object.freeze({
  // Testnet fees are several CCD per contract update (measured 28 Nov: pay_ccd 20.6 CCD, refused retry 5.6 CCD), so
  // the starter drop covers the become-a-payee flow (about 5 updates) plus a 0.5 CCD payment.
  faucetMicro: 150_000_000n,
  faucetSkipAboveMicro: 100_000_000n,
  faucetPerDay: 25,
  faucetPerIpPerDay: 3,
  invoicesPerPayerPerDay: 3,
  invoicesPerIpPerHour: 6,
  invoicesPerDay: 60,
  lowBalanceMicro: 100_000_000n,
  payMaxEnergy: 6000,
});

export function createWalletDesk(deps) {
  const { kv, hitWindow, now = Date.now, internalAccounts = [], registry, chain, policy = DESK_POLICY } = deps;
  const schemas = () => deps.schemas ?? {}; // read lazily: the schema loads after boot
  const DAY = 86_400_000;

  function need(addr, what = 'account') {
    if (!isAddress(addr)) throw new OpenError(400, 'bad_account', `That is not a Concordium ${what} address.`);
    return addr;
  }
  async function budget(key, windowMs, limit, msg) {
    const r = await hitWindow(key, windowMs, limit);
    if (!r.allowed) throw new OpenError(429, 'rate_limited', msg, { retry_after_s: Math.ceil((r.resetMs ?? windowMs) / 1000) });
  }

  async function account(addr) {
    need(addr);
    const bal = await chain.balanceMicro(addr);
    if (bal === null) return { account: addr, exists: false, balance_ccd: null, needs_funds: true };
    return { account: addr, exists: true, balance_ccd: microToCcd(bal), balance_micro: String(bal), needs_funds: bal < policy.lowBalanceMicro };
  }

  async function faucet(addr, ip = 'unknown') {
    need(addr);
    if (internalAccounts.includes(addr)) throw new OpenError(409, 'internal_account', 'That is one of PayOnce\u2019s own demo accounts.');
    const bal = await chain.balanceMicro(addr);
    if (bal === null) throw new OpenError(404, 'no_such_account', 'This account is not on the testnet yet. Finish creating it in your wallet, then try again.');
    if (bal >= policy.faucetSkipAboveMicro) {
      return { sent: false, reason: 'already_funded', balance_ccd: microToCcd(bal), message: `You already have ${microToCcd(bal)} CCD, enough for every step.` };
    }
    // 1. Concordium's own testnet faucet (wallet-proxy testnetGTUDrop): works once per account, only before any
    //    incoming transfer. It answers with a tx hash, or an old hash if it already paid this account.
    if (chain.officialDrop) {
      const off = await chain.officialDrop(addr).catch(() => null);
      if (off?.txHash) {
        await kv.put('wallet_faucet_official', addr, { at: new Date(now()).toISOString(), tx_hash: off.txHash });
        return { sent: true, source: 'concordium_faucet', tx_hash: off.txHash, message: 'Concordium\u2019s testnet faucet is sending test CCD to your account.' };
      }
    }
    // 2. Fallback: PayOnce's one-time starter drop.
    const prior = await kv.get('wallet_faucet', addr);
    if (prior) return { sent: false, reason: 'already_sent', tx_hash: prior.tx_hash, message: 'This account already got its starter CCD. Use the faucet button in your wallet for more.' };
    await budget(`faucet-ip:${ip}`, DAY, policy.faucetPerIpPerDay, 'Starter CCD is limited per network. Use the faucet button in your wallet.');
    await budget('faucet-all', DAY, policy.faucetPerDay, 'Today\u2019s starter CCD is used up. Use the faucet button in your wallet.');
    // Claim first: a send that fails after submission is never retried (unknown status is never resubmitted).
    const claimed = await kv.putIfAbsent('wallet_faucet', addr, { at: new Date(now()).toISOString(), tx_hash: null });
    if (!claimed) return { sent: false, reason: 'already_sent', message: 'This account already got its starter CCD.' };
    let sent;
    try {
      sent = await chain.sendTransfer(addr, policy.faucetMicro);
    } catch (e) {
      await kv.put('wallet_faucet', addr, { at: new Date(now()).toISOString(), tx_hash: null, error: String(e?.message ?? e).slice(0, 160) });
      throw new OpenError(503, 'faucet_send_failed', 'The starter transfer could not be sent. Use the faucet button in your wallet instead.');
    }
    await kv.put('wallet_faucet', addr, { at: new Date(now()).toISOString(), tx_hash: sent.txHash });
    return { sent: true, source: 'payonce_starter', tx_hash: sent.txHash, amount_ccd: microToCcd(policy.faucetMicro) };
  }

  async function invoiceFor(payer, ip = 'unknown') {
    need(payer);
    if (internalAccounts.includes(payer)) throw new OpenError(409, 'internal_account', 'That is one of PayOnce\u2019s own demo accounts. Connect your own wallet account.');
    await budget(`winv-payer:${payer}`, DAY, policy.invoicesPerPayerPerDay, 'This account already has 3 test invoices today. Pay one of those.');
    await budget(`winv-ip:${ip}`, 3_600_000, policy.invoicesPerIpPerHour, 'Too many test invoices from this network this hour. Try again later.');
    await budget('winv-all', DAY, policy.invoicesPerDay, 'Today\u2019s test invoices are used up. Try again tomorrow.');
    const out = await chain.registerInvoiceFor(payer);
    const rec = { seller: out.seller, payable_id: out.payable_id, payer, tx_hash: out.tx_hash, at: new Date(now()).toISOString() };
    await kv.put('wallet_invoice', `${out.seller}:${out.payable_id}`, rec);
    return { ...out, expected_payer: payer };
  }

  async function payTransaction(seller, id, payerAccount) {
    need(seller, 'seller');
    need(payerAccount);
    const pid = Number(id);
    if (!Number.isSafeInteger(pid) || pid < 0) throw new OpenError(400, 'bad_id', 'payable id must be a whole number.');
    const view = await chain.getPayable(seller, pid);
    if (!view) throw new OpenError(404, 'not_found', `No invoice ${pid} for that seller is on the registry.`);
    if (view.asset !== 'CCD') throw new OpenError(409, 'wrong_asset', 'This invoice is paid in EUDemo tokens; wallet payment here covers CCD invoices.');
    if (view.status !== 'Unpaid') throw new OpenError(409, 'not_unpaid', view.status === 'Paid' ? 'This invoice is already paid. The registry pays an invoice exactly once.' : `This invoice is ${view.status}.`, { status: view.status });
    const dueMs = Number(view.dueMs ?? Date.parse(view.due));
    if (Number.isFinite(dueMs) && dueMs < now()) throw new OpenError(409, 'past_due', 'This invoice is past its due date; the registry refuses late payment.');
    if (payerAccount === seller) throw new OpenError(409, 'self_payment', 'A seller cannot pay its own invoice.');
    const expected = view.expectedPayer ?? null;
    if (expected && expected !== payerAccount) {
      throw new OpenError(409, 'not_expected_payer', 'This invoice names a different payer. Only that account can pay it; the registry would refuse yours.', { expected_payer: expected });
    }
    if (!schemas().payCcd) throw new OpenError(503, 'schema_unavailable', 'The wallet parameter schema is not loaded on this server.');
    return {
      invoice: { seller, payable_id: pid, payee: view.payee, amount_micro: String(view.amount), amount_ccd: microToCcd(BigInt(view.amount)), due: view.due ?? null, doc_sha256: view.docHash ?? null, expected_payer: expected, agent_token: view.agentToken ?? null },
      transaction: {
        type: 'Update',
        contract: { index: registry.index, subindex: registry.subindex },
        receive_name: `${registry.name}.pay_ccd`,
        amount_micro: String(view.amount),
        parameter_json: { seller, payable_id: pid },
        schema: { type: 'parameter', value: schemas().payCcd },
        max_energy: policy.payMaxEnergy,
      },
    };
  }

  return { account, faucet, invoiceFor, payTransaction, policy };
}
