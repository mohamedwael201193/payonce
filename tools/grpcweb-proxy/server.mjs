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
// Returns true when the request was handled (it targets /concordium.v2.Queries/*), false otherwise,
// so a host server (payonce-api) can mount this in front of its own routes.
export function grpcWebProxy(req, res) {
  const url = (req.url || '').split('?')[0];
  if (!url.startsWith('/concordium.v2.')) return false;
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
  if (req.method !== 'POST' || !PATH_RE.test(url)) { fail(res, 404, 'only POST /concordium.v2.Queries/<Method>'); return true; }
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/grpc-web/.test(ct)) { fail(res, 415, 'grpc-web content-type required'); return true; }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').pop().trim();
  if (!allowed(ip)) { res.setHeader('retry-after', '1'); fail(res, 429, 'rate limited'); return true; }
  if (inflight >= MAX_INFLIGHT) { fail(res, 503, 'busy'); return true; }
  inflight++;
  let done = false;
  const finish = () => { if (!done) { done = true; inflight--; } };
  res.on('close', finish);

  // Buffer the (tiny) request so an upstream 429/5xx can be retried transparently
  // (the public node rate-limits per source IP; Render egress IPs are shared).
  const chunks = [];
  let size = 0;
  let upstream = null;
  let ended = false;
  const cancel = () => { try { upstream?.close(http2.constants.NGHTTP2_CANCEL); } catch {} };
  res.on('close', cancel);
  req.on('error', cancel);
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return fail(res, 413, 'too large'); }
    chunks.push(c);
  });
  req.on('end', () => { ended = true; attempt(0); });

  function attempt(n) {
    if (res.destroyed) return;
    const headers = { ':method': 'POST', ':path': url };
    for (const h of FWD_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
    let up;
    try { up = upstream = getSession().request(headers); } catch { return fail(res, 502, 'upstream unavailable'); }
    const timer = setTimeout(() => { try { up.close(http2.constants.NGHTTP2_CANCEL); } catch {} res.end(); }, MAX_STREAM_MS);
    let retried = false;
    const retry = () => {
      if (retried) return; retried = true; clearTimeout(timer);
      try { up.close(http2.constants.NGHTTP2_CANCEL); } catch {}
      setTimeout(() => attempt(n + 1), 250 * 2 ** n);
    };
    up.on('response', (h) => {
      const st = Number(h[':status']) || 200;
      if ((st === 429 || st === 502 || st === 503) && n < 4) return retry();
      const out = {};
      for (const k of ['content-type', 'grpc-status', 'grpc-message', 'grpc-encoding']) if (h[k]) out[k] = h[k];
      res.writeHead(st, out);
    });
    up.on('data', (c) => { if (!retried && res.headersSent) res.write(c); });
    up.on('end', () => { if (retried) return; clearTimeout(timer); res.end(); });
    up.on('error', () => { if (retried) return; clearTimeout(timer); if (n < 2 && !res.headersSent) { retried = true; return setTimeout(() => attempt(n + 1), 250); } fail(res, 502, 'upstream error'); });
    for (const c of chunks) up.write(c);
    up.end();
  }
  return true;
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = http.createServer((req, res) => {
    if (grpcWebProxy(req, res)) return;
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'payonce-ccd-grpcweb-proxy', network: 'concordium-testnet', upstream: UPSTREAM }));
    }
    fail(res, 404, 'only POST /concordium.v2.Queries/<Method>');
  });
  server.requestTimeout = 0;
  server.headersTimeout = 20_000;
  server.listen(PORT, '0.0.0.0', () => console.log(`grpcweb proxy :${PORT} -> ${UPSTREAM}`));
}
