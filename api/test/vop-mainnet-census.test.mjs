// check_payee mainnet mode + /api/census loader (offline, injected chain/network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainnetCheck, credentialDetailsOf, identityFromExplorer, MAINNET_IDPS } from '../src/vop-mainnet.mjs';
import { loadCensus, _resetCensusCache } from '../src/census.mjs';
import { VERDICT } from '../src/vop.mjs';

const PAYEE = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr';
const NOW = Date.parse('2026-11-28T08:00:00Z');
const info = (idp, validTo = '203009') => ({ accountCredentials: { 0: { v: 0, value: { type: 'normal', contents: { credId: 'A'.repeat(96), ipIdentity: idp, policy: { validTo, createdAt: '202509' } } } } } });
const nodeWith = (infoJson, fail = null) => ({ getAccountInfo: async () => { if (fail) throw fail; return infoJson; } });
const mk = (over = {}) => createMainnetCheck({ now: () => NOW, registry: async () => ({ total: 1, agents: [{ token_id: 5134, status: 'Active', agent_wallet: PAYEE }] }), ...over });

test('credentialDetailsOf reads idp, validTo, createdAt', () => {
  assert.deepEqual(credentialDetailsOf(info(3)), [{ credId: 'a'.repeat(96), idp: 3, validTo: '2030-09', createdAt: '2025-09' }]);
});
test('mainnet: business identity is UNVERIFIED, never MATCH, never payable, and says why', async () => {
  const r = await mk({ node: () => nodeWith(info(3)) })({ payee: PAYEE, name: 'Acme GmbH' });
  assert.equal(r.verdict, VERDICT.UNVERIFIED); assert.equal(r.payable, false); assert.equal(r.identity_kind, 'business');
  assert.equal(r.mode, 'identity_only'); assert.equal(r.subject.network, 'Mainnet');
  assert.deepEqual(r.subject.identity_providers, [{ index: 3, name: 'Global FinReg' }]);
  assert.equal(r.subject.registry_agents_owned.total, 1);
  assert.match(r.reasons.join(' '), /not which company/); assert.match(r.evidence_hash, /^[0-9a-f]{64}$/);
});
test('mainnet: person identity is UNVERIFIED and business is not claimed', async () => {
  const r = await mk({ node: () => nodeWith(info(2)) })({ payee: PAYEE, name: 'Acme GmbH' });
  assert.equal(r.identity_kind, 'person'); assert.equal(r.verdict, VERDICT.UNVERIFIED); assert.equal(r.payable, false);
});
test('mainnet: unknown account is NO_MATCH', async () => {
  const r = await mk({ node: () => nodeWith(null, Object.assign(new Error('NOT_FOUND: account'), { code: 5 })) })({ payee: PAYEE, name: 'Acme GmbH' });
  assert.equal(r.verdict, VERDICT.NO_MATCH); assert.equal(r.payable, false);
});
test('mainnet: an expired credential is flagged', async () => {
  const r = await mk({ node: () => nodeWith(info(2, '202606')) })({ payee: PAYEE, name: 'Acme GmbH' });
  const c = r.checks.find((x) => x.id === 'credential_validity');
  assert.equal(c.ok, false); assert.match(c.detail, /EXPIRED/);
});
test('mainnet: node failure falls back to the explorer and says so; both down -> 503, no verdict', async () => {
  const down = () => ({ getAccountInfo: async () => { throw new Error('UNAVAILABLE'); } });
  const r = await mk({ node: down, explorer: async () => ({ exists: true, address: PAYEE, credentials: [{ credId: null, idp: 3, validTo: null }], source: 'ccdexplorer' }) })({ payee: PAYEE, name: 'Acme GmbH' });
  assert.equal(r.subject.source, 'ccdexplorer'); assert.equal(r.subject.node_error, 'UNAVAILABLE'); assert.equal(r.identity_kind, 'business');
  await assert.rejects(mk({ node: down, explorer: async () => { throw new Error('boom'); } })({ payee: PAYEE, name: 'Acme GmbH' }), (e) => e.status === 503);
});
test('mainnet: bad address / missing name are 400', async () => {
  await assert.rejects(mk()({ payee: 'nope', name: 'x' }), (e) => e.status === 400 && e.code === 'bad_address');
  await assert.rejects(mk()({ payee: PAYEE }), (e) => e.status === 400 && e.code === 'bad_name');
});
test('explorer fallback parses the provider name', async () => {
  const html = '<td>ID Provider</td> Global FinReg Credential ID abc';
  const r = await identityFromExplorer(PAYEE, async () => ({ status: 200, ok: true, text: async () => `<html>Identity 1 --> Key Value --> ID Provider Global FinReg Credential ID abc</html>` }));
  assert.equal(r.credentials[0].idp, 3); assert.equal(MAINNET_IDPS[3], 'Global FinReg');
});

test('census: serves github copy with freshness; falls back to bundled; flags stale', async () => {
  _resetCensusCache();
  const base = { schema: 'payonce-vop-census/v1', generated_at_utc: new Date(NOW - 2 * 3_600_000).toISOString(), networks: { mainnet: { agents_total: 1 }, testnet: { agents_total: 1 } } };
  const ok = await loadCensus({ fetchImpl: async () => ({ ok: true, json: async () => base }), now: () => NOW });
  assert.equal(ok.served.source, 'github'); assert.equal(ok.served.age_hours, 2); assert.equal(ok.served.stale, false);
  _resetCensusCache();
  const old = { ...base, generated_at_utc: new Date(NOW - 30 * 3_600_000).toISOString() };
  const fb = await loadCensus({ fetchImpl: async () => { throw new Error('offline'); }, now: () => NOW, readLocal: () => old });
  assert.equal(fb.served.source, 'bundled'); assert.equal(fb.served.stale, true);
  _resetCensusCache();
});
