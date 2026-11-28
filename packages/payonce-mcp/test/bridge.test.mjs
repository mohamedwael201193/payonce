import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { forward, serve } from '../bin/payonce-mcp.mjs';

const reply = (status, json) => async () => ({ status, ok: status < 400, text: async () => (json === undefined ? '' : JSON.stringify(json)) });

test('forward returns the hosted reply, null for a 202 notification, and retries a flaky 503', async () => {
  assert.deepEqual(await forward({ jsonrpc: '2.0', id: 1, method: 'ping' }, { fetchImpl: reply(200, { jsonrpc: '2.0', id: 1, result: {} }) }), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(await forward({ jsonrpc: '2.0', method: 'notifications/initialized' }, { fetchImpl: reply(202) }), null);
  let n = 0; const flaky = async () => (++n === 1 ? reply(503, {})() : reply(200, { jsonrpc: '2.0', id: 2, result: { ok: 1 } })());
  assert.equal((await forward({ jsonrpc: '2.0', id: 2, method: 'x' }, { fetchImpl: flaky })).result.ok, 1); assert.equal(n, 2);
});

test('an unreachable server becomes a JSON-RPC error for requests and silence for notifications', async () => {
  const down = async () => { throw new Error('boom'); };
  const r = await forward({ jsonrpc: '2.0', id: 3, method: 'x' }, { fetchImpl: down, retries: 0 });
  assert.equal(r.error.code, -32000); assert.match(r.error.message, /unreachable/);
  assert.equal(await forward({ jsonrpc: '2.0', method: 'notifications/x' }, { fetchImpl: down, retries: 0 }), null);
});

test('serve: one line in, one line out; bad JSON gets a parse error', async () => {
  const input = new PassThrough(); const output = new PassThrough(); const lines = [];
  output.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  const done = serve({ input, output, url: 'http://x', fetchImpl: reply(200, { jsonrpc: '2.0', id: 7, result: { tools: [] } }) });
  input.write('{"jsonrpc":"2.0","id":7,"method":"tools/list"}\nnot json\n'); input.end(); await done;
  assert.equal(lines.length, 2);
  assert.ok(lines.some((l) => l.id === 7 && l.result)); assert.ok(lines.some((l) => l.error?.code === -32700));
});
