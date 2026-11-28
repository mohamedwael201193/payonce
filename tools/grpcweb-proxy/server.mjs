// Minimal, restricted gRPC-web reverse proxy for the Concordium TESTNET node.
// Purpose: lets environments that cannot reach grpc.testnet.concordium.com:20000
// (corporate/sandbox egress) use a normal https :443 endpoint, e.g. the Concordium
// Wallet extension's "Custom network" settings. No secrets, no state, no deps.
//
//   browser/extension --(grpc-web, h1/h2, :443)--> this proxy --(h2)--> testnet node :20000
//
// Restrictions: testnet upstream is hard-coded; only POST /concordium.v2.Queries/<Method>
// (SendBlockItem is a Queries method); body <= 512 KiB; per-IP rate limit; stream cap.
import http from 'node:http';
import http2 from 'node:http2';

const UPSTREAM = process.env.UPSTREAM || 'https://grpc.testnet.concordium.com:20000';
const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 512 * 1024;
const MAX_STREAM_MS = 60_000;
const RATE_PER_SEC = Number(process.env.RATE_PER_SEC || 25);
const BURST = Number(process.env.BURST || 100);
const MAX_INFLIGHT = 150;
const PATH_RE = /^\/concordium\.v2\.Queries\/[A-Za-z]{3,40}$/;
const ORIGIN_RE = /^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f-]+|https?:\/\/localhost(:\d+)?|https?:\/\/127\.0\.0\.1(:\d+)?|https:\/\/[a-z0-9.-]*payonce[a-z0-9.-]*\.vercel\.app|https:\/\/[a-z0-9.-]*onrender\.com)$/;
const FWD_HEADERS = ['content-type', 'x-grpc-web', 'x-user-agent', 'grpc-timeout', 'grpc-accept-encoding', 'grpc-encoding', 'accept'];

let session = null;
function getSession() {
  if (session && !session.closed && !session.destroyed) return session;
  const s = http2.connect(UPSTREAM);
  s.on('error', () => { if (session === s) session = null; });
  s.on('close', () => { if (session === s) session = null; });
  s.on('goaway', () => { if (session === s) session = null; });
  s.setTimeout(120_000, () => s.close());
  session = s;
  return s;
}

const buckets = new Map();
function allowed(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { t: BURST, at: now };
  b.t = Math.min(BURST, b.t + ((now - b.at) / 1000) * RATE_PER_SEC);
  b.at = now;
  if (b.t < 1) { buckets.set(ip, b); return false; }
  b.t -= 1; buckets.set(ip, b); return true;
}
setInterval(() => { const c = Date.now() - 300_000; for (const [k, v] of buckets) if (v.at < c) buckets.delete(k); }, 60_000).unref();

function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGIN_RE.test(o)) { res.setHeader('access-control-allow-origin', o); res.setHeader('vary', 'origin'); }
  else if (!o) res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-grpc-web, x-user-agent, grpc-timeout, grpc-accept-encoding, grpc-encoding, accept');
  res.setHeader('access-control-expose-headers', 'grpc-status, grpc-message, grpc-encoding, grpc-accept-encoding');
  res.setHeader('access-control-max-age', '86400');
}
const fail = (res, code, msg) => { if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain' }); res.end(msg); };

let inflight = 0;
const server = http.createServer((req, res) => {
  cors(req, res);
  const url = (req.url || '').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && (url === '/' || url === '/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'payonce-ccd-grpcweb-proxy', network: 'concordium-testnet', upstream: UPSTREAM, allowed: '/concordium.v2.Queries/*' }));
  }
  if (req.method !== 'POST' || !PATH_RE.test(url)) return fail(res, 404, 'only POST /concordium.v2.Queries/<Method>');
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/grpc-web/.test(ct)) return fail(res, 415, 'grpc-web content-type required');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').pop().trim();
  if (!allowed(ip)) { res.setHeader('retry-after', '1'); return fail(res, 429, 'rate limited'); }
  if (inflight >= MAX_INFLIGHT) return fail(res, 503, 'busy');
  inflight++;
  let done = false;
  const finish = () => { if (!done) { done = true; inflight--; } };
  res.on('close', finish);

  let size = 0;
  const headers = { ':method': 'POST', ':path': url };
  for (const h of FWD_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
  let up;
  try { up = getSession().request(headers); } catch { return fail(res, 502, 'upstream unavailable'); }
  const timer = setTimeout(() => { up.close(http2.constants.NGHTTP2_CANCEL); res.end(); }, MAX_STREAM_MS);
  up.on('response', (h) => {
    const out = {};
    for (const k of ['content-type', 'grpc-status', 'grpc-message', 'grpc-encoding']) if (h[k]) out[k] = h[k];
    res.writeHead(Number(h[':status']) || 200, out);
  });
  up.on('data', (c) => res.write(c));
  up.on('trailers', (t) => { // trailers-only / HTTP trailers: surface for non-grpc-web fallbacks
    if (!res.headersSent) return;
  });
  up.on('end', () => { clearTimeout(timer); res.end(); });
  up.on('error', () => { clearTimeout(timer); fail(res, 502, 'upstream error'); });
  res.on('close', () => { clearTimeout(timer); try { up.close(http2.constants.NGHTTP2_CANCEL); } catch {} });
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); try { up.close(http2.constants.NGHTTP2_CANCEL); } catch {} return fail(res, 413, 'too large'); }
    up.write(c);
  });
  req.on('end', () => up.end());
  req.on('error', () => { try { up.close(http2.constants.NGHTTP2_CANCEL); } catch {} });
});
server.requestTimeout = 0;
server.headersTimeout = 20_000;
server.listen(PORT, '0.0.0.0', () => console.log(`grpcweb proxy :${PORT} -> ${UPSTREAM}`));
