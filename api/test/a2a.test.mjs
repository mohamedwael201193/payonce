import test from 'node:test';
import assert from 'node:assert/strict';
import { createA2A, inputFromMessage } from '../src/a2a.mjs';

const ACC = '3okVZTaSqFtzNMZfbst1pyweWMQZBkgTWSp5fqnJTkDtxRLMYJ';
const mk = (verdict = 'MATCH') => { const calls = []; return { calls, a2a: createA2A({ check: async (i) => { calls.push(i); return { verdict, reasons: ['r1'] }; } }) }; };
const send = (parts, extra = {}) => ({ jsonrpc: '2.0', id: 7, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'm1', parts, ...extra } } });

test('message/send with a data part returns an agent message: text advice + full result', async () => {
  const { a2a, calls } = mk('CLOSE_MATCH');
  const r = await a2a.handle(send([{ kind: 'data', data: { payee: ACC, name: 'Acme ApS' } }], { contextId: 'c1' }));
  assert.equal(r.id, 7); assert.equal(r.result.kind, 'message'); assert.equal(r.result.role, 'agent'); assert.equal(r.result.contextId, 'c1');
  assert.match(r.result.parts[0].text, /^CLOSE_MATCH: Close match: stop and ask the person/);
  assert.equal(r.result.parts[1].data.outcome, 'close_match');
  assert.deepEqual([calls[0].payee, calls[0].seller, calls[0].legal_name, calls[0].network], [ACC, ACC, 'Acme ApS', undefined]);
});

test('invoice text is read with the parser; mainnet is passed through; missing input gets a question, not a check', async () => {
  const { a2a, calls } = mk('UNVERIFIED');
  const txt = `Acme ApS\nPayee: Acme ApS\nPay to ${ACC}\nTotal due 12 CCD`;
  const r = await a2a.handle(send([{ kind: 'text', text: txt }, { kind: 'data', data: { network: 'mainnet' } }]));
  assert.equal(calls[0].payee, ACC); assert.equal(calls[0].legal_name, 'Acme ApS'); assert.equal(calls[0].network, 'mainnet');
  assert.equal(r.result.parts[1].data.outcome, 'not_possible');
  const none = await a2a.handle(send([{ kind: 'text', text: 'hello' }]));
  assert.match(none.result.parts[0].text, /I need two things/); assert.equal(calls.length, 1);
});

test('errors follow JSON-RPC and A2A codes; a check failure says nothing was paid; batches work', async () => {
  const { a2a } = mk();
  assert.equal((await a2a.handle({ nope: 1 })).error.code, -32600);
  assert.equal((await a2a.handle({ jsonrpc: '2.0', id: 1, method: 'x/y' })).error.code, -32601);
  assert.equal((await a2a.handle({ jsonrpc: '2.0', id: 1, method: 'message/stream' })).error.code, -32004);
  assert.equal((await a2a.handle({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 't' } })).error.code, -32001);
  assert.equal((await a2a.handle({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} })).error.code, -32602);
  const bad = createA2A({ check: async () => { throw new Error('node down'); } });
  assert.match((await bad.handle(send([{ kind: 'data', data: { payee: ACC, name: 'A' } }]))).error.message, /Nothing was paid/);
  const batch = await a2a.handle([send([{ kind: 'data', data: { payee: ACC, name: 'A' } }]), { jsonrpc: '2.0', id: 2, method: 'x' }]);
  assert.equal(batch.length, 2); assert.equal(batch[1].error.code, -32601);
  assert.deepEqual(inputFromMessage({ parts: [] }), {});
});
