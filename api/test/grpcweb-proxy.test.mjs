import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';

// Fake h2c "node": echoes the grpc-web request body back plus a trailer frame.
const up = http2.createServer();
up.on('stream', (st, h) => {
  const chunks = [];
  st.on('data', (c) => chunks.push(c));
  st.on('end', () => {
    st.respond({ ':status': 200, 'content-type': 'application/grpc-web+proto' });
    st.end(Buffer.concat([Buffer.from(h[':path']), Buffer.from('|'), ...chunks]));
  });
});
await new Promise((r) => up.listen(0, '127.0.0.1', r));
process.env.UPSTREAM = `http://127.0.0.1:${up.address().port}`;
process.env.BURST = '5'; process.env.RATE_PER_SEC = '0.0001';
const { grpcWebProxy } = await import('../../tools/grpcweb-proxy/server.mjs');
const srv = http.createServer((q, s) => { if (!grpcWebProxy(q, s)) { s.writeHead(418); s.end('host'); } });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const post = (path, ct = 'application/grpc-web+proto', body = 'abc') => fetch(base + path, { method: 'POST', headers: { 'content-type': ct, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }, body });

test('relays Queries calls and reflects an extension origin', async () => {
  const r = await post('/concordium.v2.Queries/GetConsensusInfo');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '/concordium.v2.Queries/GetConsensusInfo|abc');
  assert.match(r.headers.get('access-control-allow-origin'), /^chrome-extension:/);
});
test('refuses everything outside concordium.v2.Queries and non grpc-web', async () => {
  assert.equal((await post('/concordium.v2.Other/Do')).status, 404);
  assert.equal((await post('/concordium.v2.Queries/Get1')).status, 404);
  assert.equal((await post('/concordium.v2.Queries/GetConsensusInfo', 'application/json')).status, 415);
  assert.equal((await fetch(base + '/concordium.v2.Queries/GetConsensusInfo')).status, 404);
  assert.equal((await fetch(base + '/api/health')).status, 418, 'non-proxy paths fall through to the host');
});
test('preflight and rate limit', async () => {
  const o = await fetch(base + '/concordium.v2.Queries/GetConsensusInfo', { method: 'OPTIONS', headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } });
  assert.equal(o.status, 204);
  let limited = 0;
  for (let i = 0; i < 8; i++) if ((await post('/concordium.v2.Queries/GetConsensusInfo')).status === 429) limited++;
  assert.ok(limited > 0);
});
test.after(() => { srv.closeAllConnections?.(); srv.close(); up.close(); setTimeout(() => process.exit(0), 50).unref(); });
