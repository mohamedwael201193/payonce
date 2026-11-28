import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPayee, probeX402, decide, payeeCard, CheckPayeeError } from '../src/index.mjs';
import { main } from '../bin/cli.mjs';

const ACC = '3okVZTaSqFtzNMZfbst1pyweWMQZBkgTWSp5fqnJTkDtxRLMYJ';
const reply = (status, json) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(json) });
const spy = (status, json) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return reply(status, json)(); }; f.calls = calls; return f; };
const run = async (args, fetchImpl) => { const o = []; const e = []; const code = await main(args, { out: (s) => o.push(s), err: (s) => e.push(s), env: {}, fetchImpl }); return { code, out: o.join('\n'), err: e.join('\n') }; };

test('decide: four outcomes; anything unknown is "not possible", never a pay', () => {
  assert.deepEqual([decide('MATCH').action, decide('CLOSE_MATCH').action, decide('NO_MATCH').action, decide('UNVERIFIED').action], ['pay', 'ask_human', 'refuse', 'ask_human']);
  assert.equal(decide('WAT').action, 'ask_human'); assert.equal(decide(undefined).outcome, 'not_possible');
});

test('checkPayee asks /api/check-payee with the payee as seller by default', async () => {
  const f = spy(200, { verdict: 'MATCH', reasons: [] });
  const r = await checkPayee({ payee: ACC, name: 'Acme ApS', api: 'http://api.test', fetchImpl: f });
  assert.equal(r.outcome, 'match'); assert.equal(r.exit, 0);
  assert.equal(f.calls[0].url, `http://api.test/api/check-payee?payee=${ACC}&seller=${ACC}&legal_name=Acme%20ApS`);
});

test('probeX402 posts the probe (no payment) and maps the outcome', async () => {
  const f = spy(200, { requires_payment: true, selected: { amount_ccd: '2', pay_to: ACC }, check: { verdict: 'UNVERIFIED', reasons: ['personal identity (provider 0), no name proof'] }, decision: { outcome: 'not_possible', action: 'ask_human' } });
  const r = await probeX402({ url: 'https://seller.test/x', name: 'Seller', api: 'http://api.test', fetchImpl: f });
  assert.equal(f.calls[0].url, 'http://api.test/api/x402/probe'); assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(r.outcome, 'not_possible'); assert.equal(r.exit, 3);
});

test('errors: usage is refused, an HTTP error is an error, reads retry a flaky 503 once', async () => {
  await assert.rejects(() => checkPayee({ name: 'x' }), CheckPayeeError);
  await assert.rejects(() => checkPayee({ payee: ACC, name: 'x', api: 'http://a', fetchImpl: reply(400, { error: { message: 'bad_address' } }), retries: 0 }), /bad_address/);
  let n = 0; const flaky = async () => (++n === 1 ? reply(503, {})() : reply(200, { verdict: 'MATCH' })());
  assert.equal((await checkPayee({ payee: ACC, name: 'x', api: 'http://a', fetchImpl: flaky })).outcome, 'match'); assert.equal(n, 2);
});

test('CLI exit codes follow the outcome', async () => {
  for (const [verdict, code] of [['MATCH', 0], ['NO_MATCH', 1], ['CLOSE_MATCH', 2], ['UNVERIFIED', 3]]) {
    const r = await run([ACC, '--name', 'Acme ApS'], reply(200, { verdict, reasons: [] }));
    assert.equal(r.code, code, verdict); assert.match(r.out, new RegExp(`Verdict  ${verdict}`));
  }
  assert.equal((await run([ACC], reply(200, {}))).code, 64);
  assert.equal((await run([])).code, 64);
});

test('CLI x402: prints price, payTo and outcome; --json passes through; card works', async () => {
  const probe = { url: 'https://s.test/x', requires_payment: true, selected: { amount_ccd: '0.5', pay_to: ACC }, check: { verdict: 'NO_MATCH', reasons: ['name differs'] }, decision: { outcome: 'no_match', action: 'refuse' } };
  const r = await run(['x402', 'https://s.test/x', '--name', 'S', '--api', 'http://api.test'], reply(200, probe));
  assert.equal(r.code, 1); assert.match(r.out, /Price    0\.5 CCD/); assert.match(r.out, /Outcome  no_match/);
  const j = await run(['x402', 'https://s.test/x', '--name', 'S', '--json'], reply(200, probe));
  assert.equal(JSON.parse(j.out).selected.pay_to, ACC);
  const c = await run(['card', ACC], reply(200, { label: 'Verified payee: Acme ApS', account: ACC }));
  assert.equal(c.code, 0); assert.match(c.out, /Verified payee: Acme ApS/);
  assert.equal((await payeeCard(ACC, { api: 'http://a', fetchImpl: reply(200, { account: ACC }) })).account, ACC);
});

test('--network mainnet reaches the API as network=mainnet; testnet adds nothing; anything else is refused', async () => {
  const f = spy(200, { verdict: 'UNVERIFIED', reasons: [] });
  const r = await run([ACC, '--name', 'Acme ApS', '--network', 'mainnet'], f);
  assert.equal(r.code, 3); assert.match(f.calls[0].url, /&network=mainnet$/);
  const g = spy(200, { verdict: 'MATCH', reasons: [] });
  await run([ACC, '--name', 'Acme ApS', '--network', 'testnet'], g);
  assert.doesNotMatch(g.calls[0].url, /network=/);
  assert.equal((await run([ACC, '--name', 'x', '--network', 'devnet'], g)).code, 70);
  await assert.rejects(() => checkPayee({ payee: ACC, name: 'x', network: 'devnet' }), /testnet or mainnet/);
});
