// PayOnce backend — self-hosted x402 facilitator HTTP server (testnet only).
// Endpoints:
//   GET  /health     — facilitator address, network, sponsor balance + low flag,
//                      rate-limit config, ledger size. No keys.
//   GET  /supported  — x402 /supported shape: scheme, network, feePayer, signers.
//   POST /verify     — {payload, requirements, payableId, expectedStatus} ->
//                      the PayOnce verify layer (scheme 9 checks + payable binding).
//   POST /settle     — same input -> verify, then sponsor-sign + submit +
//                      wait finalization; the settled tx is appended to the
//                      JSONL ledger (test/facilitator-ledger.jsonl).
// Rate limit: 30 req/min per IP on /verify and /settle (Doris safeguard #3).
// The sponsor signer is in-memory only (safeguard #2); nothing secret is
// logged or returned. Start: `node src/facilitator/server.mjs [port]`.
import http from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { grpcClient } from '../chain.mjs';
import { createFacilitator, payonceVerify, payonceSettle, sponsorBalance, RateLimiter, TESTNET_CAIP2, LOW_BALANCE_CCD } from './scheme.mjs';
import { OWNER_ADDRESS } from '../send.mjs';

const PORT = Number(process.argv[2] ?? process.env.FACILITATOR_PORT ?? 8091);
const LEDGER_PATH = new URL('../../test/facilitator-ledger.jsonl', import.meta.url).pathname;

const facilitator = createFacilitator();
const limiter = new RateLimiter();
const client = grpcClient();

function ledgerSize() {
  if (!existsSync(LEDGER_PATH)) return 0;
  return readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean).length;
}
function appendLedger(entry) {
  mkdirSync(new URL('../../test/', import.meta.url).pathname, { recursive: true });
  appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function rateLimit(req, res) {
  const ip = req.socket.remoteAddress ?? 'unknown';
  const r = limiter.allow(ip);
  if (!r.allowed) {
    send(res, 429, { error: 'rate_limited', message: 'too many requests; retry after the window (60s)', remaining: 0 });
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      const bal = await sponsorBalance(client).catch(() => ({ microCcd: 'unknown', ccd: null, low: true }));
      return send(res, 200, {
        status: 'ok', network: 'testnet', caip2: TESTNET_CAIP2,
        facilitator: facilitator.sponsorAddress,
        sponsorBalanceMicroCcd: bal.microCcd, sponsorBalanceCcd: bal.ccd,
        lowBalanceWarning: bal.low, lowBalanceThresholdCcd: LOW_BALANCE_CCD,
        rateLimit: { maxRequests: limiter.maxRequests, windowMs: limiter.windowMs },
        ledgerEntries: ledgerSize(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/supported') {
      return send(res, 200, {
        scheme: 'exact', network: TESTNET_CAIP2,
        extra: facilitator.scheme.getExtra(TESTNET_CAIP2),
        signers: facilitator.scheme.getSigners(TESTNET_CAIP2),
      });
    }
    if (req.method === 'POST' && (url.pathname === '/verify' || url.pathname === '/settle')) {
      if (!rateLimit(req, res)) return;
      const body = await readBody(req);
      const { payload, requirements, payableId, expectedStatus } = body;
      if (!payload || !requirements || payableId === undefined) {
        return send(res, 400, { error: 'bad_request', message: 'payload, requirements and payableId are required' });
      }
      // The x402 scheme throws (500) on a malformed payload instead of
      // returning invalid — fail closed with a clean 400 here instead.
      if (typeof payload.accepted !== 'object' || payload.accepted === null
        || payload.accepted.scheme !== 'exact' || typeof payload.accepted.network !== 'string'
        || typeof payload.payload !== 'object' || payload.payload === null) {
        return send(res, 400, { error: 'bad_request', message: 'payload must be an x402 PaymentPayload: {accepted:{scheme:"exact",network}, payload:{signedTransaction}}' });
      }
      if (url.pathname === '/verify') {
        const out = await payonceVerify(facilitator, payload, requirements, { payableId, expectedStatus });
        return send(res, 200, out);
      }
      const out = await payonceSettle(facilitator, payload, requirements, { payableId, expectedStatus });
      if (out.success) {
        appendLedger({
          at: new Date().toISOString(), network: facilitator.network,
          payableId, payer: out.payer, transaction: out.transaction,
          amount: requirements.amount, asset: requirements.asset, payTo: requirements.payTo,
        });
      }
      return send(res, 200, out);
    }
    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    return send(res, 500, { error: 'internal', message: String(e.message).slice(0, 300) });
  }
});

server.listen(PORT, () => {
  console.log(`PayOnce facilitator listening on http://localhost:${PORT} (testnet, sponsor ${OWNER_ADDRESS.slice(0, 8)}…)`);
});
