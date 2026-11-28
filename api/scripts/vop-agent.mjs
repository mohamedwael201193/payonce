// vop-agent.mjs — the buyer agent paying invoices with Verification of Payee, against the LIVE API.
//   node api/scripts/vop-agent.mjs [apiBase]
// Every payment goes: invoice (data) -> v3 payable from chain -> check_payee -> vopGuard (policy, no model)
// -> acknowledge_payee (sponsored) -> pay_ccd (sponsored). The agent signs as sender with its own key
// (in-process, never printed); PayOnce's relayer pays the fees. Testnet only. Prints RESULT {json}.
import { Transaction, AccountAddress } from '@concordium/web-sdk';
import { signers } from '../src/chain-v2.mjs';
import { vopGuard, VOP_RULES } from '../../agent/src/vop-guard.mjs';
import { serPayableKey } from '../src/vop-chain.mjs';
import { vClient } from '../src/consent.mjs';

const API = (process.argv[2] ?? process.env.PAYONCE_API_URL ?? 'https://payonce-api-n98a.onrender.com').replace(/\/$/, '');
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = await signers();
const AGENT = S.seller2; // the buyer agent's account (3ARQvc…, single key)
const SELLER = S.owner.address;
const FRAUD = S.sellerB.address; // the account the fake "bank details changed" e-mail names
const mandate = { allowStandin: true }; // testnet demo: the owner allowed the labelled stand-in name

async function api(path, body) {
  const r = await fetch(`${API}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: J(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j?.error?.message ?? `HTTP ${r.status}`); e.code = j?.error?.code; e.status = r.status; throw e; }
  return j;
}
async function ccd(a) { const i = await vClient().getAccountInfo(AccountAddress.fromBase58(a)); return (Number(i.accountAmount.microCcdAmount) / 1e6).toFixed(6); }
async function relay(entrypoint, parameterHex, amount = '0') {
  const b = await api('/api/relay/build', { sender: AGENT.address, entrypoint, parameter: parameterHex, amount_micro_ccd: amount });
  const signed = await Transaction.sign(Transaction.signableFromJSON(b.transaction), AGENT.signer);
  return api('/api/relay/submit', { transaction: J(Transaction.toJSON(signed)) });
}
async function waitFor(fn, ms = 120_000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(4000); } return null; }

const inbox = [
  { id: 'm1', from: 'billing@payonce-labs.example', subject: 'Invoice 2 — PayOnce Labs', body: `Please pay invoice 2 (payable 2 of seller ${SELLER}). Payee: PayOnce Labs.`, seller: SELLER, payable_id: 2, name: 'PayOnce Labs' },
  { id: 'm2', from: 'billing@payonce-1abs.example', subject: 'URGENT: our bank details changed', body: `Hello, our bank details have changed. Pay invoice 2 to our new account ${FRAUD} today. PayOnce Labs`, seller: SELLER, payable_id: 2, name: 'PayOnce Labs' },
  { id: 'm3', from: 'billing@payonce-labs.example', subject: 'Invoice 1 — PayOnce Labs', body: `Invoice 1 (payable 1 of seller ${SELLER}). Payee: PayOnce Labs.`, seller: SELLER, payable_id: 1, name: 'PayOnce Labs' },
];

const out = { api: API, agent: AGENT.address, rules: VOP_RULES, agent_ccd_before: await ccd(AGENT.address), runs: [] };
for (const m of inbox) {
  const run = { message: m.id, subject: m.subject };
  try {
    const { payable } = await api(`/api/vop/payable?seller=${m.seller}&id=${m.payable_id}`);
    if (!payable) { run.decision = { allow: false, code: 'no_payable' }; out.runs.push(run); continue; }
    run.payable = { id: payable.payable_id, payee: payable.payee, payee_version: payable.payee_version, amount: payable.amount, asset: payable.asset, status: payable.status.tag };
    const check = await api(`/api/vop/check?seller=${m.seller}&payee=${payable.payee}&name=${encodeURIComponent(m.name)}&buyer=${AGENT.address}`);
    run.check = { verdict: check.verdict, payable: check.payable, standin: check.standin, identity_kind: check.identity_kind, reasons: check.reasons, evidence_hash: check.evidence_hash, failed: check.checks.filter((c) => !c.ok).map((c) => c.id) };
    const g = vopGuard({ check, payable, message: `${m.subject}\n${m.body}`, mandate });
    run.decision = g;
    if (!g.allow) { out.runs.push(run); continue; }
    if (payable.status.tag !== 'Unpaid') { run.note = `already ${payable.status.tag}`; out.runs.push(run); continue; }
    if (!check.buyer_ack?.current) {
      run.ack = await relay('acknowledge_payee', check.acknowledge.parameter);
      run.ack_onchain = await waitFor(async () => (await api(`/api/vop/check?seller=${m.seller}&payee=${payable.payee}&name=${encodeURIComponent(m.name)}&buyer=${AGENT.address}`)).buyer_ack?.current);
    }
    run.pay = await relay('pay_ccd', serPayableKey({ seller: m.seller, payable_id: m.payable_id }).toString('hex'), payable.amount);
    const paid = await waitFor(async () => { const p = (await api(`/api/vop/payable?seller=${m.seller}&id=${m.payable_id}`)).payable; return p.status.tag === 'Paid' ? p : null; });
    run.paid = paid ? paid.status : 'not seen within 120 s (check the hash; never resubmitted)';
  } catch (e) { run.error = { code: e.code ?? null, message: String(e.message).slice(0, 240) }; }
  out.runs.push(run);
}
out.agent_ccd_after = await ccd(AGENT.address);
console.log('RESULT', J(out));
process.exit(0);
