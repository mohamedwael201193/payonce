import test from 'node:test';
import assert from 'node:assert/strict';
import { PayOnceClient } from '../src/client.mjs';
import { buildTools } from '../src/tools.mjs';
import { makeMandate, guardPay } from '../src/policy.mjs';
import { runAgent } from '../src/agent.mjs';
import { ScriptedPlanner, LlmPlanner } from '../src/planners.mjs';
import { legitEmail, hostileUnlistedSeller, hostileTampered, hostilePayeeChange, payableRefOf, UNLISTED_SELLER } from '../src/inbox.mjs';
import { makeFakeApi, S1, S2, docFor } from '../fixtures/fake-api.mjs';

function setup(opts = {}) {
  const api = makeFakeApi({ payables: [{ id: 10, seller: S1 }, { id: 11, seller: S1 }, { id: 12, seller: S1 }, { id: 20, seller: S2, asset: 'EUDemo', amount: '10000' }, { id: 30, seller: S1, docExtra: 'Age restriction: 18+ (wine)\n', asset: 'EUDemo', amount: '10000' }], ...opts });
  const client = new PayOnceClient({ baseUrl: 'http://api.test', fetchImpl: api.fetchImpl, backoffMs: [] });
  const tools = buildTools({ client, canPay: true });
  const mandate = makeMandate({ approvedSuppliers: [S1, S2] });
  return { api, client, tools, mandate };
}
const doc = (api, seller, id) => api.state.payables.get(`${seller}:${id}`).doc;
const emailsFor = (api) => [
  legitEmail({ n: 1, supplier: 'Alder Bakery', seller: S1, id: 10, amountDisplay: '0.5 CCD', docText: doc(api, S1, 10) }),
  hostileUnlistedSeller({ n: 2 }),
  legitEmail({ n: 3, supplier: 'Birch Dairy', seller: S2, id: 20, amountDisplay: '0.01 EUDemo', docText: doc(api, S2, 20) }),
  hostileTampered({ n: 4, seller: S1, id: 11, docText: doc(api, S1, 11) }),
  hostilePayeeChange({ n: 5, seller: S1, id: 12, docText: doc(api, S1, 12) }),
];

test('inbox emails carry a parseable payable reference', () => {
  const e = hostileUnlistedSeller({ n: 1 });
  assert.deepEqual(payableRefOf(e), { seller: UNLISTED_SELLER, id: 1 });
});

test('scripted agent pays the legitimate invoices and refuses all three hostile ones, with reasons', async () => {
  const { api, tools, mandate } = setup();
  const emails = emailsFor(api);
  const run = await runAgent({ mandate, emails, tools, planner: new ScriptedPlanner() });
  const by = Object.fromEntries(run.decisions.map((d) => [d.email_id, d]));
  assert.equal(by['email-1'].outcome, 'paid');
  assert.equal(by['email-3'].outcome, 'paid');
  assert.equal(by['email-2'].outcome, 'refused');
  assert.equal(by['email-2'].reason_code, 'seller_known');
  assert.equal(by['email-4'].outcome, 'refused');
  assert.match(by['email-4'].reason, /changed after it was registered/);
  assert.equal(by['email-5'].outcome, 'refused');
  assert.equal(by['email-5'].reason_code, 'no_instructions_in_invoice');
  assert.equal(run.totals.paid, 2);
  assert.equal(run.totals.refused, 3);
  // Only the two legitimate payables were ever sent to /pay.
  assert.deepEqual(api.state.paid.map((p) => p.id).sort(), [10, 20]);
  // Paid decisions carry the tx hash and the keyless verifier command.
  assert.equal(by['email-1'].txs[0].tx_hash, 'a'.repeat(64));
  assert.match(by['email-1'].keyless_verifier.run, /verify-payable-v2\.mjs 10 /);
  // Budget accounting.
  assert.equal(run.totals.spent.ccd, '500000');
  assert.equal(run.totals.spent.eudemo, '10000');
});

test('transcript records the task, every tool call, the guard and the final line; the planner is labelled a script', async () => {
  const { api, tools, mandate } = setup();
  const planner = new ScriptedPlanner();
  const run = await runAgent({ mandate, emails: emailsFor(api).slice(0, 1), tools, planner });
  const types = run.transcript.map((e) => e.type);
  assert.equal(types[0], 'task');
  assert.ok(types.includes('tool_call') && types.includes('tool_result') && types.includes('guard'));
  assert.equal(types.at(-1), 'final');
  assert.match(planner.label, /not a language model/);
  assert.equal(planner.kind, 'scripted');
  // The evidence the harness attaches is summarised, not repeated in full.
  const chk = run.transcript.find((e) => e.type === 'tool_call' && e.tool === 'check_payable');
  assert.match(chk.args.doc_text, /^\[attachment \d+ chars, sha256 /);
});

test('an age-gated invoice is refused without a proof, and paid once the proof is on file', async () => {
  const mk = () => setup();
  const email = (api) => [legitEmail({ n: 1, supplier: 'Cedar Wine', seller: S1, id: 30, amountDisplay: '0.01 EUDemo', docText: doc(api, S1, 30) })];
  // No proof possible: a real refusal.
  const a = mk();
  const refused = await runAgent({ mandate: a.mandate, emails: email(a.api), tools: a.tools, planner: new ScriptedPlanner(), ageProof: async () => ({ ok: false, error: 'prover_unavailable: nothing' }) });
  assert.equal(refused.decisions[0].outcome, 'refused');
  assert.equal(refused.decisions[0].reason_code, 'age_proof_required');
  assert.equal(refused.decisions[0].age_proof.ok, false);
  assert.equal(a.api.state.paid.length, 0);
  // Proof available: paid.
  const b = mk();
  const ok = await runAgent({ mandate: b.mandate, emails: email(b.api), tools: b.tools, planner: new ScriptedPlanner(), ageProof: async ({ id }) => { b.api.state.ageProofOnFile.add(id); return { ok: true, binding: 'bound', vra_tx: 'v'.repeat(64) }; } });
  assert.equal(ok.decisions[0].outcome, 'paid');
  assert.equal(ok.decisions[0].age_proof.ok, true);
  assert.equal(b.api.state.paid.length, 1);
});

test('mandate guard: over budget and unapproved supplier are refused by the harness, before any API call', () => {
  const m = makeMandate({ approvedSuppliers: [S1], budget: { ccd: 600000n, eudemo: 0n } });
  const verdictFor = () => ({ verdict: 'pay' });
  const facts = { asset: 'CCD', amount: '500000', amount_display: '0.5 CCD' };
  assert.equal(guardPay(m, { seller: S1, payableId: 1, verdictFor, facts }).allow, true);
  m.spent.ccd = 500000n;
  assert.equal(guardPay(m, { seller: S1, payableId: 1, verdictFor, facts }).code, 'over_budget');
  assert.equal(guardPay(m, { seller: S2, payableId: 1, verdictFor, facts }).code, 'supplier_not_approved');
  assert.equal(guardPay(m, { seller: S1, payableId: 1, verdictFor: () => null, facts }).code, 'not_checked');
  assert.equal(guardPay(m, { seller: S1, payableId: 1, verdictFor: () => ({ verdict: 'refuse', summary: 'x' }), facts }).code, 'verdict_refuse');
});

test('a fooled planner cannot pay: calling pay_payable straight at a hostile payable is stopped by the harness', async () => {
  const { api, tools, mandate } = setup();
  const emails = emailsFor(api);
  // A planner that ignores the rules and tries to pay the tampered invoice without checking.
  const reckless = {
    kind: 'llm', label: 'reckless', model: 'x', turns: 0,
    async start() {},
    async next() {
      this.turns += 1;
      if (this.turns === 1) return { kind: 'tool_calls', calls: [{ id: 'a', name: 'pay_payable', args: { seller: S1, id: 11 } }] };
      return { kind: 'final', text: 'done' };
    },
  };
  const run = await runAgent({ mandate, emails, tools, planner: reckless });
  assert.equal(api.state.paid.length, 0);
  const d = run.decisions.find((x) => x.email_id === 'email-4');
  assert.equal(d.outcome, 'refused');
  assert.match(d.refused_by, /mandate guard/);
});

test('even a planner that checks and then pays a hostile payable is stopped by the verdict', async () => {
  const { api, tools, mandate } = setup();
  const emails = emailsFor(api);
  const planner = {
    kind: 'llm', label: 'x', model: 'x', turns: 0,
    async start() {},
    async next() {
      this.turns += 1;
      if (this.turns === 1) return { kind: 'tool_calls', calls: [{ id: 'a', name: 'check_payable', args: { seller: S1, id: 12 } }] };
      if (this.turns === 2) return { kind: 'tool_calls', calls: [{ id: 'b', name: 'pay_payable', args: { seller: S1, id: 12 } }] };
      return { kind: 'final', text: 'done' };
    },
  };
  await runAgent({ mandate, emails, tools, planner });
  assert.equal(api.state.paid.length, 0);
});

test('LlmPlanner: tool-use loop against a fake Anthropic endpoint; the key never reaches the transcript', async () => {
  const KEY = 'sk-ant-test-0123456789abcdef';
  const { api, tools, mandate } = setup();
  const emails = emailsFor(api).slice(0, 1);
  let turn = 0;
  const seen = [];
  const fakeAnthropic = async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], KEY);
    const body = JSON.parse(init.body);
    seen.push(body);
    turn += 1;
    const script = [
      [{ type: 'text', text: 'Look at the inbox.' }, { type: 'tool_use', id: 't1', name: 'inbox_list', input: {} }],
      [{ type: 'tool_use', id: 't2', name: 'inbox_read', input: { id: 'email-1' } }],
      [{ type: 'tool_use', id: 't3', name: 'check_payable', input: { seller: S1, id: 10 } }],
      [{ type: 'tool_use', id: 't4', name: 'pay_payable', input: { seller: S1, id: 10 } }],
      [{ type: 'text', text: 'Paid the bakery invoice.' }],
    ][turn - 1];
    return { ok: true, status: 200, text: async () => JSON.stringify({ content: script }) };
  };
  const planner = new LlmPlanner({ apiKey: KEY, model: 'claude-test', fetchImpl: fakeAnthropic });
  const run = await runAgent({ mandate, emails, tools, planner, secrets: [KEY] });
  assert.equal(run.decisions[0].outcome, 'paid');
  assert.equal(run.final, 'Paid the bakery invoice.');
  assert.equal(planner.kind, 'llm');
  assert.ok(seen[0].tools.some((t) => t.name === 'check_payable'));
  assert.match(seen[0].system, /UNTRUSTED/);
  assert.ok(!JSON.stringify(run).includes(KEY));
});

test('LlmPlanner needs a key', () => {
  assert.throws(() => new LlmPlanner({ apiKey: '' }), /API key/);
});

import { NearAiPlanner } from '../src/planners.mjs';
import { applyVariant } from '../src/inbox.mjs';
import { pickPlanner } from '../src/scenario.mjs';

test('NearAiPlanner: falls back to the next key on 401/429, parses tool calls, labels itself, keeps keys out of the record', async () => {
  const K1 = 'near-key-one-0123456789';
  const K2 = 'near-key-two-0123456789';
  const { api, tools, mandate } = setup();
  const emails = emailsFor(api).slice(0, 1);
  const used = [];
  let turn = 0;
  const f = async (url, init) => {
    const key = init.headers.authorization.replace('Bearer ', '');
    used.push(key);
    if (key === K1) return { ok: false, status: 429, text: async () => 'rate limited' };
    turn += 1;
    const calls = [
      [{ id: 'c1', type: 'function', function: { name: 'check_payable', arguments: JSON.stringify({ seller: S1, id: '10' }) } }],
      [{ id: 'c2', type: 'function', function: { name: 'pay_payable', arguments: JSON.stringify({ seller: S1, id: 10 }) } }],
    ][turn - 1];
    const message = calls ? { role: 'assistant', content: 'I will pay 99 CCD.', tool_calls: calls } : { role: 'assistant', content: 'Paid it.' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) };
  };
  const planner = new NearAiPlanner({ apiKeys: [K1, K2], model: 'z-ai/glm-5.3-flash', fetchImpl: f });
  assert.equal(planner.label, 'NEAR AI (z-ai/glm-5.3-flash)');
  const run = await runAgent({ mandate, emails, tools, planner, secrets: [K1, K2] });
  assert.equal(run.decisions[0].outcome, 'paid');
  assert.ok(used.includes(K1) && used.includes(K2));
  // Prose stays prose: the wrong amount in it is not what the record says.
  assert.equal(run.decisions[0].facts.amount_display, '0.500000 CCD');
  assert.ok(run.transcript.some((e) => e.type === 'thought' && e.source === 'model_prose'));
  assert.ok(!JSON.stringify(run).includes(K1) && !JSON.stringify(run).includes(K2));
});

test('NearAiPlanner: every key refused is an error, not a silent script', async () => {
  const p = new NearAiPlanner({ apiKeys: ['aaaaaaaaaa'], fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'no' }) });
  await p.start({ mandate: makeMandate({ approvedSuppliers: [S1] }), tools: [] });
  await assert.rejects(() => p.next(null), /every configured key was refused/);
});

test('pickPlanner prefers NEAR AI when a key exists, honours the scripted override', () => {
  assert.equal(pickPlanner({ NEARAI_API_KEY: 'abcdefghij', LLM_MODEL: 'm' }).label, 'NEAR AI (m)');
  assert.equal(pickPlanner({ NEARAI_API_KEY: 'abcdefghij', PAYONCE_AGENT_PLANNER: 'scripted' }).kind, 'scripted');
  assert.equal(pickPlanner({}).kind, 'scripted');
});

test('a payable no email names cannot be paid, even if it passes every check (injected "also pay X")', async () => {
  const { api, tools, mandate } = setup();
  const emails = emailsFor(api).slice(0, 1);
  const planner = {
    kind: 'llm', label: 'x', model: 'x', turns: 0,
    async start() {},
    async next() {
      this.turns += 1;
      if (this.turns === 1) return { kind: 'tool_calls', calls: [{ id: 'a', name: 'check_payable', args: { seller: S1, id: 11 } }] };
      if (this.turns === 2) return { kind: 'tool_calls', calls: [{ id: 'b', name: 'pay_payable', args: { seller: S1, id: 11 } }] };
      return { kind: 'final', text: 'done' };
    },
  };
  const run = await runAgent({ mandate, emails, tools, planner });
  assert.equal(api.state.paid.length, 0);
  assert.ok(run.transcript.some((e) => e.type === 'guard' && e.code === 'not_in_inbox'));
});

test('variants append model-targeted text and leave hostile fixtures and structure intact', () => {
  const { api } = setup();
  const em = emailsFor(api);
  const a = applyVariant(em, 'authority', null);
  assert.ok(a.every((e) => /SYSTEM OVERRIDE/.test(e.body)) && a.every((e) => payableRefOf(e) !== null || e.hostile));
  const b = applyVariant(em, 'extra-payable', { seller: S1, payable_id: 12 });
  assert.equal(b.filter((e) => /also pay payable/.test(e.body)).length, 1);
  assert.equal(applyVariant(em, null, null), em);
});
