import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnchorService, anchorBytesHex, evidenceOf, recomputeEvidenceHash, AnchorError } from '../src/vop-anchor.mjs';

const mkResult = () => { const r = { verdict: 'UNVERIFIED', verified_name: null, verified_country: null, identity_kind: 'person', standin: false, checks: [{ id: 'account_exists', ok: true, detail: 'x' }], subject: { payee: 'P' }, checked_at: 'now' }; r.evidence_hash = recomputeEvidenceHash(evidenceOf(r)); return r; };
function mk(over = {}) {
  const store = new Map(); const sends = [];
  const kv = { get: async (ns, k) => store.get(`${ns}:${k}`) ?? null, put: async (ns, k, v) => { store.set(`${ns}:${k}`, v); }, putIfAbsent: async (ns, k, v) => { if (store.has(`${ns}:${k}`)) return false; store.set(`${ns}:${k}`, v); return true; } };
  const deps = { check: async () => mkResult(), kv, send: async (d) => { sends.push(d); return { txHash: 'ab'.repeat(32) }; }, waitFinalized: async () => ({ ok: true }),
    status: async () => ({ status: 'finalized', dataHex: sends[0] }), budget: async () => ({ allowed: true }), explorer: (t) => `https://x/${t}`, now: () => 1_800_000_000_000, ...over };
  return { svc: createAnchorService(deps), sends, store };
}
test('anchors the server-computed evidence_hash once; the receipt recomputes and matches the chain bytes', async () => {
  const { svc, sends } = mk();
  const a = await svc.anchor({ payee: 'P', name: 'x' }, { ip: '1' });
  assert.equal(a.anchored, true); assert.equal(a.already_anchored, false); assert.equal(sends.length, 1);
  assert.equal(sends[0], anchorBytesHex(a.evidence_hash)); assert.equal(sends[0].length, 74);
  assert.equal(a.recomputed_hash_matches, true);
  const again = await svc.anchor({ payee: 'P', name: 'x' }, { ip: '1' });
  assert.equal(again.already_anchored, true); assert.equal(sends.length, 1);
  const g = await svc.get(a.evidence_hash);
  assert.equal(g.chain_data_matches, true); assert.equal(g.chain_status, 'finalized'); assert.equal(g.evidence.verdict, 'UNVERIFIED');
});
test('an unknown send outcome is never resubmitted', async () => {
  const { svc, sends, store } = mk({ send: async () => { throw new Error('socket hang up'); } });
  await assert.rejects(svc.anchor({ payee: 'P', name: 'x' }), (e) => e.code === 'anchor_status_unknown');
  const h = mkResult().evidence_hash; assert.equal(store.get(`vop_anchor:${h}`).state, 'unknown');
  const svc2 = createAnchorService({ ...{}, check: async () => mkResult(), kv: { get: async (n, k) => store.get(`${n}:${k}`) ?? null, put: async (n, k, v) => store.set(`${n}:${k}`, v), putIfAbsent: async (n, k, v) => (store.has(`${n}:${k}`) ? false : (store.set(`${n}:${k}`, v), true)) }, send: async () => { sends.push('SECOND'); return { txHash: 'cd'.repeat(32) }; }, waitFinalized: async () => ({ ok: true }), status: async () => null, budget: async () => ({ allowed: true }) });
  const r = await svc2.anchor({ payee: 'P', name: 'x' });
  assert.equal(r.already_anchored, true); assert.equal(r.state, 'unknown'); assert.ok(!sends.includes('SECOND'));
});
test('a send rejected before acceptance (notSent) may be retried', async () => {
  let n = 0;
  const { svc } = mk({ send: async () => { n++; if (n === 1) throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { notSent: true }); return { txHash: 'ab'.repeat(32) }; } });
  await assert.rejects(svc.anchor({ payee: 'P', name: 'x' }), (e) => e.code === 'anchor_not_sent');
  const ok = await svc.anchor({ payee: 'P', name: 'x' });
  assert.equal(ok.anchored, true); assert.equal(n, 2);
});
test('budget, mainnet, tampered evidence and bad hash are refused', async () => {
  await assert.rejects(mk({ budget: async () => ({ allowed: false, retryAfterS: 60 }) }).svc.anchor({ payee: 'P', name: 'x' }), (e) => e.status === 429);
  await assert.rejects(mk().svc.anchor({ network: 'mainnet', payee: 'P', name: 'x' }), (e) => e.code === 'testnet_only');
  await assert.rejects(mk({ check: async () => ({ ...mkResult(), verdict: 'MATCH' }) }).svc.anchor({ payee: 'P', name: 'x' }), (e) => e.code === 'hash_mismatch');
  await assert.rejects(mk().svc.get('zz'), (e) => e.status === 400);
  await assert.rejects(mk().svc.get('a'.repeat(64)), (e) => e.status === 404);
  const { svc } = mk({ perDay: 0 });
  await assert.rejects(svc.anchor({ payee: 'P', name: 'x' }), (e) => e.code === 'daily_budget_used');
});

import { dataHexFromExplorerHtml, resolveTxStatus } from '../src/vop-anchor-wiring.mjs';
const PVOP = '50564f5031' + 'c8ce36f9d7ea033fdc5038fb46239dee4c349ea3c70df2fe619c1d1038d95309';
test('explorer HTML parser finds the PVOP1 registered data', () => {
  assert.equal(dataHexFromExplorerHtml(`<td>Registered Data</td><td>${PVOP.toUpperCase()}</td>`), PVOP);
  assert.equal(dataHexFromExplorerHtml('<html>no data</html>'), null);
});
test('tx status: node first; explorer fallback is labelled and used only after node 429s', async () => {
  const fromNode = async () => ({ status: 'finalized', dataHex: PVOP });
  const r = await resolveTxStatus('ab', { fromNode, fromExplorer: async () => { throw new Error('must not'); } });
  assert.equal(r.source, 'node'); assert.equal(r.dataHex, PVOP);
  let n = 0;
  const flaky = async () => { n++; throw new Error('Received HTTP status code 429'); };
  const ex = await resolveTxStatus('ab', { fromNode: flaky, fromExplorer: async () => ({ status: 'finalized', dataHex: PVOP, source: 'ccdexplorer' }) });
  assert.equal(ex.source, 'ccdexplorer'); assert.equal(ex.dataHex, PVOP); assert.equal(n, 4);
  await assert.rejects(resolveTxStatus('ab', { fromNode: async () => { throw new Error('NOT_FOUND'); }, fromExplorer: async () => ({ status: 'finalized', dataHex: PVOP, source: 'ccdexplorer' }) }));
});
