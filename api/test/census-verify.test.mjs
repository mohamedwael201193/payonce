import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, censusAccounts, verifyNetwork, runVerification, loadAndVerify, _resetVerifyCache } from '../src/census-verify.mjs';

const csv = 'token_id,owner_account,agent_wallet,agent_uri,owner_idp,payee_idp\r\n1,A1,A1,"https://x/a,b.json",Notabene,Notabene\r\n2,A2,,,Digital Trust Solutions,\r\n3,A3,B3,,Notabene,Global FinReg\r\n';
test('parseCsv handles quotes, commas and CRLF', () => {
  const r = parseCsv(csv);
  assert.equal(r.length, 3); assert.equal(r[0].agent_uri, 'https://x/a,b.json'); assert.equal(r[2].payee_idp, 'Global FinReg');
});
test('censusAccounts: payee is agentWallet or the owner when unset', () => {
  const m = censusAccounts(parseCsv(csv));
  assert.equal(m.get('A2'), 'Digital Trust Solutions'); assert.equal(m.get('B3'), 'Global FinReg'); assert.equal(m.get('A3'), 'Notabene');
});
const NODE = { A1: ['Notabene'], A2: ['Digital Trust Solutions'], A3: ['Notabene'], B3: ['Global FinReg'] };
test('verify: every business account is checked, agreement counted, a mismatch is reported', async () => {
  const ok = await verifyNetwork({ net: 'mainnet', rows: parseCsv(csv), readIdps: async (a) => NODE[a], n: 10 });
  assert.equal(ok.sample_size, 4); assert.equal(ok.agree, 4); assert.equal(ok.mismatch, 0); assert.equal(ok.business_accounts_checked, 1); assert.equal(ok.agreement_rate, 1);
  const bad = await verifyNetwork({ net: 'mainnet', rows: parseCsv(csv), readIdps: async (a) => (a === 'B3' ? ['Notabene'] : NODE[a]), n: 10 });
  assert.equal(bad.mismatch, 1); assert.equal(bad.accounts.find((x) => x.account === 'B3').result, 'mismatch'); assert.equal(bad.agreement_rate, 0.75);
});
test('verify: node errors are counted, never treated as agreement', async () => {
  const r = await verifyNetwork({ net: 'testnet', rows: parseCsv(csv), readIdps: async (a) => { if (a === 'A1') throw new Error('UNAVAILABLE'); return NODE[a]; }, n: 10 });
  assert.equal(r.node_errors, 1); assert.equal(r.agree, 3);
});
test('sample is deterministic for a seed and includes all business accounts', async () => {
  const rows = []; for (let i = 0; i < 200; i++) rows.push({ token_id: String(i), owner_account: `O${i}`, agent_wallet: '', agent_uri: '', owner_idp: i === 7 ? 'Global FinReg' : 'Notabene', payee_idp: '' });
  const go = (seed) => verifyNetwork({ net: 'mainnet', rows, readIdps: async () => ['Notabene'], n: 10, seed });
  const a = await go(5); const b = await go(5); const c = await go(6);
  assert.deepEqual(a.accounts.map((x) => x.account), b.accounts.map((x) => x.account));
  assert.notDeepEqual(a.accounts.map((x) => x.account), c.accounts.map((x) => x.account));
  assert.ok(a.accounts.some((x) => x.account === 'O7')); assert.equal(a.sample_size, 11);
});
test('runVerification: all_agree needs zero mismatches, zero errors and a real sample; loadAndVerify caches', async () => {
  const rows = []; for (let i = 0; i < 60; i++) rows.push({ token_id: String(i), owner_account: `O${i}`, agent_wallet: '', agent_uri: '', owner_idp: 'Notabene', payee_idp: '' });
  const r = await runVerification({ rowsByNet: { mainnet: rows, testnet: rows }, readIdps: () => async () => ['Notabene'], n: 25, seed: 1, now: () => 1_800_000_000_000 });
  assert.equal(r.all_agree, true); assert.equal(r.schema, 'payonce-census-verification/v1'); assert.match(r.scope, /sample/);
  _resetVerifyCache(); let runs = 0;
  const run = async () => { runs++; return { ok: true }; };
  const deps = { fetchImpl: async () => ({ ok: true, text: async () => csv }), readLocal: () => csv, run, now: () => 5 };
  const one = await loadAndVerify(deps); const two = await loadAndVerify(deps);
  assert.equal(runs, 1); assert.equal(one.cached, false); assert.equal(two.cached, true); _resetVerifyCache();
});
