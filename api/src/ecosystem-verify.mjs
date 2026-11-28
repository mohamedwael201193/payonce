// PayOnce API - public verification for ANY seller on the PayOnce registry (ecosystem tools).
//
// Used by the hosted MCP tools `check_invoice` / `verify_payable`, by GET /api/verify/payable and by
// the GitHub Action / npm verifier (which run the same checks straight against a node). Read-only,
// keyless. A seller does not have to be known to PayOnce: every fact comes from the chain or from the
// official Agent Registry badge check.
//
// Verdicts:
//   safe_to_pay   - open, not past due, seller agent Active + owned + badge valid, doc hash matches when given,
//                   buyer's vendor row (when a buyer is named) admits the amount
//   already_paid  - Paid on chain (with the payment evidence when a tx hash is given and verifies)
//   do_not_pay    - anything else; every failed check says why
const row = (id, label, status, detail) => ({ id, label, status, detail });

export function payableVerdict({ view, agent, badge, vendor = null, buyer = null, docSha256 = null, chainNowMs, receiptChecks = null, payeePolicy = 'warn' }) {
  const checks = [];
  if (!view) {
    checks.push(row('registered', 'Payable is registered on the PayOnce registry', 'fail', 'no payable with this (seller, id) key'));
    return { verdict: 'do_not_pay', checks, facts: null };
  }
  const facts = {
    seller: view.seller, payable_id: view.id, amount: String(view.amount), asset: view.asset, payee: view.payee,
    due: view.due, doc_sha256: view.docHash, agent_token: Number(view.agentToken), expected_payer: view.expectedPayer ?? null,
    status: view.status, payer: view.record?.payer ?? null, paid_at: view.record?.paidAt ?? null, recorded_tx: view.record?.txHash ?? null,
  };
  checks.push(row('registered', 'Payable is registered on the PayOnce registry', 'ok', `${view.asset} ${view.amount} (base units) to ${view.payee.slice(0, 10)}…`));
  const paid = view.status === 'Paid';
  if (paid) checks.push(row('status', 'Payable status', 'ok', `Paid by ${String(view.record?.payer ?? '?').slice(0, 10)}… at ${view.record?.paidAt ?? '?'}; the contract refuses any second payment (-5 / -16)`));
  else checks.push(row('status', 'Payable is open (Unpaid)', view.status === 'Unpaid' ? 'ok' : 'fail', `status=${view.status}`));
  if (!paid) {
    const dueOk = Number(view.dueMs) >= chainNowMs;
    checks.push(row('not_past_due', 'Due date is in the future (chain time)', dueOk ? 'ok' : 'fail', `due ${view.due}`));
  }
  const agentOk = agent && agent.status === 'Active' && agent.owner === view.seller;
  checks.push(row('seller_agent', 'Seller agent is Active on <12802,0> and owned by the seller', agentOk ? 'ok' : 'fail',
    agent ? `token ${view.agentToken}: status=${agent.status}, owner ${agent.owner === view.seller ? 'matches' : 'differs'}` : `token ${view.agentToken}: not found`));
  const badgeOk = badge?.badge_valid === true;
  checks.push(row('seller_badge', 'Official "Verified by Concordium" badge check (15 checks)', badgeOk ? 'ok' : (badge ? 'fail' : 'warn'),
    badge ? `badge_valid:${badge.badge_valid}${badge.issues?.length ? `; issues ${JSON.stringify(badge.issues).slice(0, 160)}` : ''}` : 'the registry badge service did not answer'));
  const walletOk = view.payee === view.seller || (agent?.agentWallet && view.payee === agent.agentWallet);
  checks.push(row('payee_is_seller_wallet', 'Payee is the seller account or its registry agentWallet', walletOk ? 'ok' : payeePolicy,
    walletOk ? 'payee is the seller\'s own wallet' : `payee ${view.payee.slice(0, 10)}… is a third account: check the invoice names it`));
  if (docSha256) {
    const ok = String(docSha256).toLowerCase() === String(view.docHash).toLowerCase();
    checks.push(row('doc_hash', 'Your copy of the invoice is the registered one (SHA-256)', ok ? 'ok' : 'fail', ok ? 'hash matches the chain' : `your copy ${String(docSha256).slice(0, 12)}…, chain ${String(view.docHash).slice(0, 12)}…: the document was changed`));
  }
  if (buyer) {
    if (view.expectedPayer && view.expectedPayer !== buyer) checks.push(row('expected_payer', 'This buyer is the payer the seller named', 'fail', `the payable names ${view.expectedPayer.slice(0, 10)}… (the contract reverts -21 for anyone else)`));
    if (!vendor) checks.push(row('buyer_vendor_row', 'Seller is on this buyer\'s on-chain vendor list', 'fail', 'no approval row (strict buyers revert -19)'));
    else {
      const capOk = BigInt(view.amount) <= BigInt(vendor.perPayableCap);
      checks.push(row('buyer_vendor_row', 'Seller is on this buyer\'s on-chain vendor list and the amount is within the cap', capOk ? 'ok' : 'fail', `tier ${vendor.tier}, per-payable cap ${vendor.perPayableCap}${capOk ? '' : ' (over cap: the contract reverts -23)'}`));
    }
  }
  if (receiptChecks) for (const c of receiptChecks) checks.push(c);
  const failed = checks.filter((c) => c.status === 'fail');
  const verdict = paid ? (failed.filter((c) => c.id !== 'not_past_due').length ? 'do_not_pay' : 'already_paid') : failed.length ? 'do_not_pay' : 'safe_to_pay';
  return { verdict, checks, facts };
}
