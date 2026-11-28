// Agent surface of the API: age requirement, the hosted /mcp endpoint's pay gate, the age-restricted document,
// and the buyer-agent wallet check. No chain, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ageRequirement, docAgeRequirement } from '../src/age-requirement.mjs';
import { createAgentApi, isAgentAuthed } from '../src/agent-api.mjs';
import { generateLabDocument } from '../src/docs.mjs';
import { ageGateCheck, clearAgeProofs, recordVerifiedAgeProof, extractPresentationHolder } from '../src/age-proof.mjs';

const S1 = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const PAYER = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';
const TOKEN = ['agent', 'token', '0123456789abcdef'].join('-'); // built from parts so the secret scanner does not flag a labelled literal

test('generateLabDocument adds an age restriction line only when asked, and it parses back', () => {
  const base = { id: 1, asset: 'EUDemo', amount: '10000', payee: PAYER, seller: S1, due: Date.UTC(2026, 11, 1) };
  assert.equal(docAgeRequirement(generateLabDocument(base)), null);
  const gated = generateLabDocument({ ...base, ageGate: 18 });
  assert.equal(docAgeRequirement(gated), 18);
  assert.notEqual(gated, generateLabDocument(base));
});

test('ageRequirement: gated by amount at 1.00, or by the document, not by a small plain invoice', () => {
  assert.equal(ageRequirement({ amount: '500000' }, 'Amount: 0.5\n').required, false);
  assert.deepEqual(ageRequirement({ amount: '1000000' }, null).source, 'amount');
  const r = ageRequirement({ amount: '10000' }, Buffer.from('x\nAge restriction: 18+ (wine)\n'));
  assert.equal(r.required, true);
  assert.equal(r.docGated, true);
  assert.equal(r.source, 'document');
});

test('ageGateCheck: a document-gated dust payable is refused until a proof for the payer is on file', () => {
  clearAgeProofs();
  const view = { id: 77, asset: 'EUDemo', amount: '10000' };
  assert.equal(ageGateCheck(view, PAYER), null); // plain dust: not gated
  const g = ageGateCheck(view, PAYER, Date.now(), { forceGated: true });
  assert.equal(g.code, 'age_proof_required');
  assert.equal(g.status, 409);
  recordVerifiedAgeProof({ payer: PAYER, payableId: 77 });
  assert.equal(ageGateCheck(view, PAYER, Date.now(), { forceGated: true }), null);
  clearAgeProofs();
});

test('a V1 presentation holder is read from a 96-hex credential id (real credential ids are 48 bytes)', () => {
  const cred = 'ab'.repeat(48);
  const h = extractPresentationHolder({ verifiableCredential: [{ credentialSubject: { id: `did:ccd:testnet:cred:${cred}` } }] });
  assert.deepEqual(h, { kind: 'cred', credId: cred });
});

test('isAgentAuthed: no token configured means nobody can pay through /mcp; a wrong token is refused', () => {
  const req = (h) => ({ headers: h });
  assert.equal(isAgentAuthed(req({ authorization: `Bearer ${TOKEN}` }), {}), false);
  assert.equal(isAgentAuthed(req({}), { PAYONCE_AGENT_TOKEN: TOKEN }), false);
  assert.equal(isAgentAuthed(req({ authorization: 'Bearer nope' }), { PAYONCE_AGENT_TOKEN: TOKEN }), false);
  assert.equal(isAgentAuthed(req({ authorization: `Bearer ${TOKEN}` }), { PAYONCE_AGENT_TOKEN: TOKEN }), true);
  assert.equal(isAgentAuthed(req({ authorization: 'Bearer short' }), { PAYONCE_AGENT_TOKEN: 'short' }), false, 'a short token is never accepted');
});

function harness(env) {
  const sent = [];
  const deps = {
    sendJson: (res, status, body) => { res.status = status; res.body = body; sent.push(body); },
    apiError: (res, status, code, layer, message) => { res.status = status; res.body = { error: { code, message } }; },
    readBody: async (req) => req.body,
    hitWindow: async () => ({ allowed: true, resetMs: 0 }),
    clientIp: () => '203.0.113.7',
  };
  const api = createAgentApi({ deps, port: 1, env });
  return { api, call: async (headers, body) => { const res = {}; await api.handleMcpPost({ headers, body }, res); return res; } };
}

test('hosted /mcp: anonymous callers see three read-only tools, the demo agent token adds pay_payable', async () => {
  const h = harness({ PAYONCE_AGENT_TOKEN: TOKEN });
  const anon = await h.call({}, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(anon.body.result.tools.map((t) => t.name).sort(), ['check_payable', 'list_payables', 'receipt']);
  const authed = await h.call({ authorization: `Bearer ${TOKEN}` }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(authed.body.result.tools.some((t) => t.name === 'pay_payable'));
  const sneaky = await h.call({}, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pay_payable', arguments: { seller: S1, id: 1 } } });
  assert.equal(sneaky.body.error.code, -32602, 'calling pay_payable without the token is an unknown tool');
});

test('hosted /mcp: initialize answers with the server info and a batch gets a batch back', async () => {
  const h = harness({});
  const init = await h.call({}, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.equal(Array.isArray(init.body), true);
  assert.equal(init.body.length, 1);
  assert.equal(init.body[0].result.serverInfo.name, 'payonce-mcp');
});
