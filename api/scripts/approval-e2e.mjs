// G11 end to end against the LIVE API: a Close-match payment needs the payer's wallet signature.
//   1. pay-tx with approved=1 (a click)        -> 409 needs_signed_approval
//   2. POST /api/approvals/request             -> the exact text the wallet signs
//   3. sign it with the payer account key (signMessage: the same digest Browser Wallet's signMessage produces)
//   4. POST /api/approvals/:id/verify          -> verified against the payer's keys on chain, ledger entry, anchor
//   5. pay-tx with approval=<id>               -> the transaction is built (nothing is paid by this script)
//   node scripts/approval-e2e.mjs [api-base]
import { AccountAddress, signMessage } from '@concordium/web-sdk';
import { signers } from '../src/chain-v2.mjs';

const BASE = process.argv[2] ?? 'https://payonce-api-n98a.onrender.com';
const S = await signers();
const PAYER = S.seller2; const PAYEE = S.owner.address; const NAME = 'PayOnce Lab'; const AMOUNT = '1000';
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const out = {};
out.click = await j(await fetch(`${BASE}/api/p/${PAYEE}/pay-tx?payer=${PAYER.address}&amount_micro=${AMOUNT}&name=${encodeURIComponent(NAME)}&approved=1`));
const req = await j(await fetch(`${BASE}/api/approvals/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payer: PAYER.address, payee: PAYEE, name: NAME, amount_micro: AMOUNT }) }));
out.request = { status: req.status, approval_id: req.body.approval_id, verdict: req.body.verdict, evidence_hash: req.body.evidence_hash, invoice_hash: req.body.invoice_hash, error: req.body.error };
if (req.status !== 200) { console.log(`APPROVAL_E2E ${JSON.stringify(out)}`); process.exit(1); }
const signature = await signMessage(AccountAddress.fromBase58(PAYER.address), req.body.message, PAYER.signer);
const ver = await j(await fetch(`${BASE}/api/approvals/${req.body.approval_id}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature }) }));
out.verify = { status: ver.status, approved: ver.body.approved, approval_hash: ver.body.approval_hash, ledger: ver.body.ledger, anchor: ver.body.anchor, error: ver.body.error };
const pay = await j(await fetch(`${BASE}/api/p/${PAYEE}/pay-tx?payer=${PAYER.address}&amount_micro=${AMOUNT}&name=${encodeURIComponent(NAME)}&approval=${req.body.approval_id}`));
out.pay_tx = { status: pay.status, verdict: pay.body.check?.verdict, approval: pay.body.approval, invoice: pay.body.invoice, has_transaction: !!pay.body.transaction, acknowledge: pay.body.acknowledge ? 'required' : null, error: pay.body.error };
const ok = out.click.status === 409 && out.click.body?.error?.code === 'needs_signed_approval' && out.verify.approved === true && pay.status === 200 && out.pay_tx.has_transaction;
out.click = { status: out.click.status, code: out.click.body?.error?.code };
console.log(`APPROVAL_E2E ${JSON.stringify({ ok, ...out })}`);
process.exit(ok ? 0 : 1);
