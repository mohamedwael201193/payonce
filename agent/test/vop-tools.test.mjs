import test from 'node:test';
import assert from 'node:assert/strict';
import { PayOnceClient } from '../src/client.mjs';
import { buildTools } from '../src/tools.mjs';
import { outcomeOf, vopGuard } from '../src/vop-guard.mjs';

const ACC = '3okVZTaSqFtzNMZfbst1pyweWMQZBkgTWSp5fqnJTkDtxRLMYJ';
function mk(canPay, handler, backoffMs = [], x402Buy = false) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    const [status, json] = await handler(String(url), init);
    return { ok: status < 400, status, text: async () => JSON.stringify(json) };
  };
  const client = new PayOnceClient({ baseUrl: 'http://api.test', fetchImpl, backoffMs });
  const tools = buildTools({ client, canPay, x402Buy });
  return { calls, t: Object.fromEntries(tools.map((x) => [x.name, x.handler])), names: tools.map((x) => x.name) };
}

test('the four outcomes map from the raw verdict, unknown is not_possible', () => {
  assert.equal(outcomeOf('MATCH'), 'match'); assert.equal(outcomeOf('CLOSE_MATCH'), 'close_match');
  assert.equal(outcomeOf('NO_MATCH'), 'no_match'); assert.equal(outcomeOf('UNVERIFIED'), 'not_possible');
  assert.equal(outcomeOf('weird'), 'not_possible');
});

test('only MATCH allows; UNVERIFIED and CLOSE_MATCH ask a person; NO_MATCH refuses', () => {
  const base = { verdict: 'MATCH', payable: true, standin: false, evidence_hash: 'e'.repeat(64), checks: [], subject: { seller: ACC, payee: ACC, book: { version: 1 } } };
  const payable = { seller: ACC, payee: ACC, payee_version: 1 };
  const g = (verdict) => vopGuard({ check: { ...base, verdict }, payable });
  assert.equal(g('MATCH').allow, true);
  for (const v of ['CLOSE_MATCH', 'UNVERIFIED']) { const r = g(v); assert.equal(r.allow, false); assert.equal(r.ask, true); }
  const n = g('NO_MATCH'); assert.equal(n.allow, false); assert.equal(n.ask, undefined);
});

test('check_payee is public, reads /api/check-payee and adds plain advice', async () => {
  const { t, names, calls } = mk(false, async () => [200, { verdict: 'UNVERIFIED', reasons: ['personal identity (provider 0), no name proof'] }]);
  assert.ok(names.includes('check_payee') && names.includes('check_x402_seller') && names.includes('get_payee_card'));
  assert.ok(!names.includes('buy_x402'), 'a caller who may not pay never sees buy_x402');
  const r = await t.check_payee({ payee: ACC, legal_name: 'Acme ApS' });
  assert.equal(r.epc_verdict, 'unverified'); assert.match(r.agent_advice, /ask the person/);
  assert.match(calls[0].url, /\/api\/check-payee\?payee=3okVZ.*&seller=3okVZ.*&legal_name=Acme%20ApS/);
});

test('buy_x402 is off unless switched on; for payers it passes approved through and is never retried', async () => {
  let n = 0;
  const { t, names, calls } = mk(true, async () => { n += 1; return [502, { error: 'bad gateway' }]; }, [10, 10, 10], true);
  assert.ok(names.includes('buy_x402'));
  assert.ok(!mk(true, async () => [200, {}]).names.includes('buy_x402'), 'a payer without x402Buy has no buy_x402');
  await assert.rejects(() => t.buy_x402({ url: 'https://x.test/p', name: 'X', approved: true }));
  assert.equal(n, 1, 'a failed purchase call is made exactly once');
  assert.equal(calls[0].body.approved, true);
  const { t: t2, calls: c2 } = mk(true, async () => [200, { outcome: 'match' }], [], true);
  await t2.buy_x402({ url: 'https://x.test/p', name: 'X', approved: 'yes' });
  assert.equal(c2[0].body.approved, false, 'only a literal true counts as approval');
});
