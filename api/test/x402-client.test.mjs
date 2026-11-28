import test from 'node:test';
import assert from 'node:assert/strict';
import { createX402Client, decide, parsePaymentRequired, pickRequirement, assertPublicUrl, isPrivateAddress, microToCcd, X402Error } from '../src/x402-client.mjs';

const PAYTO = '3u319bYkSSU3CeoMqyzt5nd72VpL5qF4oqmZoVTQQPLdBEqyL1';
const FEE = '4RkH7gpHEq4DBEP68jWEyq4k5Fgzjkjypo3tFVZKTvZKd44Y2b';
const NET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const accepts = (o = {}) => ({ x402Version: 2, resource: { url: 'https://seller.example/x' }, accepts: [{ scheme: 'exact', network: NET, amount: '2000000', asset: 'CCD', payTo: PAYTO, maxTimeoutSeconds: 120, extra: { feePayer: FEE }, ...o }] });
const headerOf = (doc) => Buffer.from(JSON.stringify(doc)).toString('base64');
const publicDns = async () => [{ address: '93.184.216.34' }];

function mockFetch(handlers) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return handlers(url, init, calls.length); };
  f.calls = calls; return f;
}
const resp = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const check = (verdict, extra = {}) => async () => ({ verdict, payable: verdict === 'MATCH', verified_name: verdict === 'MATCH' ? 'Acme ApS' : null, identity_kind: 'person', standin: false, reasons: [`r-${verdict}`], checks: [], evidence_hash: 'ab'.repeat(32), ...extra });

function client({ verdict = 'UNVERIFIED', fetchImpl, built = [], recorded = [], checkExtra } = {}) {
  const f = fetchImpl ?? mockFetch((u, init) => (init.headers['payment-signature'] ? resp(200, { ok: true }, { 'payment-response': headerOf({ success: true, transaction: 'f'.repeat(64) }) }) : resp(402, accepts(), { 'payment-required': headerOf(accepts()) })));
  return { f, built, recorded, c: createX402Client({ fetch: f, resolve: publicDns, checkPayee: check(verdict, checkExtra), buildPayload: async (a) => { built.push(a); return { x402Version: 2, accepted: a.requirement, payload: { signedTransaction: {} } }; }, record: async (r) => { recorded.push(r); } }) };
}

test('decide: the four outcomes', () => {
  assert.equal(decide({ verdict: 'MATCH', payable: true }).action, 'pay');
  assert.equal(decide({ verdict: 'MATCH', payable: false }).action, 'ask_human');
  assert.equal(decide({ verdict: 'CLOSE_MATCH' }).action, 'ask_human');
  assert.equal(decide({ verdict: 'UNVERIFIED' }).action, 'ask_human');
  assert.equal(decide({ verdict: 'NO_MATCH' }).action, 'refuse');
  assert.equal(decide({ verdict: 'UNVERIFIED' }, { approved: true }).action, 'pay');
  assert.equal(decide({ verdict: 'CLOSE_MATCH' }, { approved: true }).action, 'pay');
  const nm = decide({ verdict: 'NO_MATCH' }, { approved: true });
  assert.equal(nm.action, 'refuse');
  assert.equal(nm.human_can_override, false);
  assert.equal(decide({ verdict: 'MATCH', payable: true, standin: true }).action, 'ask_human');
  assert.equal(decide({ verdict: 'weird' }).outcome, 'not_possible');
});

test('parsePaymentRequired: header, body, v1 maxAmountRequired, nothing', () => {
  const doc = accepts();
  assert.equal(parsePaymentRequired({ headers: new Headers({ 'payment-required': headerOf(doc) }), bodyText: '' }).accepts[0].payTo, PAYTO);
  assert.equal(parsePaymentRequired({ headers: new Headers(), bodyText: JSON.stringify(doc) }).accepts[0].amount, '2000000');
  assert.equal(parsePaymentRequired({ headers: new Headers(), bodyText: JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', maxAmountRequired: '5', payTo: PAYTO }] }) }).accepts[0].amount, '5');
  assert.throws(() => parsePaymentRequired({ headers: new Headers(), bodyText: 'nope' }), (e) => e instanceof X402Error && e.code === 'not_x402');
});

test('pickRequirement: cap, network, asset, fee payer', () => {
  const a = accepts().accepts[0];
  assert.ok(pickRequirement([{ ...a, amount: '2000000' }]).requirement);
  assert.equal(pickRequirement([{ ...a, amount: '2500001' }]).requirement, null);
  assert.equal(pickRequirement([{ ...a, network: 'eip155:8453' }]).requirement, null);
  assert.equal(pickRequirement([{ ...a, asset: 'EUDemo' }]).requirement, null);
  assert.equal(pickRequirement([{ ...a, extra: {} }]).requirement, null);
  assert.equal(pickRequirement([{ ...a, scheme: 'upto' }]).requirement, null);
  assert.equal(pickRequirement([{ ...a, payTo: 'x' }]).requirement, null);
  assert.equal(microToCcd('2500000'), '2.5');
  assert.equal(microToCcd('10'), '0.00001');
});

test('SSRF guard: https only, no private hosts', async () => {
  assert.equal(isPrivateAddress('10.1.2.3'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('93.184.216.34'), false);
  for (const u of ['http://seller.example/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://user:pw@seller.example/x', 'not a url']) {
    await assert.rejects(() => assertPublicUrl(u, { resolve: publicDns }), X402Error, u);
  }
  await assert.rejects(() => assertPublicUrl('https://rebind.example/x', { resolve: async () => [{ address: '10.0.0.5' }] }), /not public/);
  assert.ok(await assertPublicUrl('https://seller.example/x', { resolve: publicDns }));
});

test('probe: reads the 402, runs check_payee on payTo, pays nothing', async () => {
  const { c, f, built } = client({ verdict: 'UNVERIFIED' });
  const r = await c.probe({ url: 'https://seller.example/x', name: 'Oracle Scout' });
  assert.equal(r.requires_payment, true);
  assert.equal(r.pay_to, PAYTO);
  assert.equal(r.selected.amount_ccd, '2');
  assert.equal(r.check.verdict, 'UNVERIFIED');
  assert.equal(r.decision.outcome, 'not_possible');
  assert.equal(r.decision.action, 'ask_human');
  assert.equal(r.paid, false);
  assert.equal(f.calls.length, 1);
  assert.equal(built.length, 0);
  assert.ok(!('_check' in r) && !('_requirement' in r));
});

test('buy: not possible without approval pays nothing; with approval pays once', async () => {
  const a = client({ verdict: 'UNVERIFIED' });
  const no = await a.c.buy({ url: 'https://seller.example/x', name: 'Oracle Scout' });
  assert.equal(no.paid, false); assert.equal(no.decision.action, 'ask_human'); assert.equal(a.built.length, 0); assert.equal(a.f.calls.length, 1);
  const b = client({ verdict: 'UNVERIFIED' });
  const yes = await b.c.buy({ url: 'https://seller.example/x', name: 'Oracle Scout', approved: true });
  assert.equal(yes.paid, true); assert.equal(yes.tx_hash, 'f'.repeat(64)); assert.equal(yes.delivered, true);
  assert.equal(b.built.length, 1); assert.equal(b.f.calls.length, 2);
  assert.ok(b.f.calls[1].init.headers['payment-signature']);
  const sent = JSON.parse(Buffer.from(b.f.calls[1].init.headers['payment-signature'], 'base64').toString());
  assert.equal(sent.accepted.payTo, PAYTO);
  assert.equal(b.recorded.length, 1); assert.equal(b.recorded[0].approved_by_human, true);
});

test('buy: a match pays by itself; a no match never pays, even when approved', async () => {
  const m = client({ verdict: 'MATCH' });
  const ok = await m.c.buy({ url: 'https://seller.example/x', name: 'Acme ApS' });
  assert.equal(ok.paid, true); assert.equal(ok.decision.action, 'pay'); assert.equal(m.recorded[0].approved_by_human, false);
  const n = client({ verdict: 'NO_MATCH' });
  const bad = await n.c.buy({ url: 'https://seller.example/x', name: 'Acme ApS', approved: true });
  assert.equal(bad.paid, false); assert.equal(bad.decision.action, 'refuse'); assert.equal(n.built.length, 0); assert.equal(n.f.calls.length, 1);
});

test('buy: close match asks first', async () => {
  const c = client({ verdict: 'CLOSE_MATCH' });
  const r = await c.c.buy({ url: 'https://seller.example/x', name: 'Acme' });
  assert.equal(r.decision.outcome, 'close_match'); assert.equal(r.decision.action, 'ask_human'); assert.equal(r.paid, false);
});

test('buy: over the cap or wrong network is refused before any payload is built', async () => {
  const big = mockFetch(() => resp(402, accepts({ amount: '9000000' })));
  const x = client({ verdict: 'MATCH', fetchImpl: big });
  const r = await x.c.buy({ url: 'https://seller.example/x', name: 'Acme', approved: true });
  assert.equal(r.paid, false); assert.equal(r.decision.action, 'refuse'); assert.match(r.decision.why, /cap/); assert.equal(x.built.length, 0);
});

test('buy: a seller that does not deliver after payment is reported, not retried', async () => {
  const f = mockFetch((u, init) => (init.headers['payment-signature'] ? resp(500, 'boom') : resp(402, accepts())));
  const x = client({ verdict: 'MATCH', fetchImpl: f });
  const r = await x.c.buy({ url: 'https://seller.example/x', name: 'Acme' });
  assert.equal(r.delivered, false); assert.equal(r.http_status, 500); assert.equal(f.calls.length, 2);
});

test('probe: a seller that does not ask for payment, and bad input', async () => {
  const ok = client({ fetchImpl: mockFetch(() => resp(200, { hello: 1 })) });
  const r = await ok.c.probe({ url: 'https://seller.example/x', name: 'x' });
  assert.equal(r.requires_payment, false); assert.equal(r.decision.action, 'refuse');
  await assert.rejects(() => ok.c.probe({ url: 'https://seller.example/x', name: '' }), /name/);
  await assert.rejects(() => ok.c.probe({ url: 'https://seller.example/x', name: 'x', method: 'DELETE' }), /method/);
});
