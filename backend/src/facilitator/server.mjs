// PayOnce backend — x402 facilitator HTTP server (testnet only).
// HOSTED-FIRST: when X402_FACILITATOR_API_KEY is set in the process env
// (or FACILITATOR_MODE=hosted), /verify + /settle route to the hosted
// testnet facilitator (hosted-payonce.mjs) with the self-hosted facilitator
// as fallback ONLY on hosted transport failure — never on a hosted
// rejection. Without the key, the server is self-hosted-only (as before).
// Endpoints:
//   GET  /health     — facilitator address, network, sponsor balance + low flag,
//                      rate-limit config, ledger size, facilitator mode. No keys.
//   GET  /supported  — x402 /supported shape: scheme, network, feePayer, signers
//                      (from the HOSTED facilitator when in hosted mode, so
//                      clients build payloads with the hosted sponsor).
//   POST /verify     — {payload, requirements, payableId, expectedStatus} ->
//                      the PayOnce verify layer (facilitator 9 checks + payable binding).
//   POST /settle     — same input -> verify, then sponsor-sign + submit +
//                      wait finalization; the settled tx is appended to the
//                      JSONL ledger (test/facilitator-ledger.jsonl).
// Rate limit: 30 req/min per IP on /verify and /settle (Doris safeguard #3).
// The sponsor signer is in-memory only (safeguard #2); nothing secret is
// logged or returned. The hosted API key is env-only and never logged.
// Start: `node src/facilitator/server.mjs [port]`.
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { grpcClient } from '../chain.mjs';
import { createFacilitator, payonceVerify, payonceSettle, sponsorBalance, RateLimiter, TESTNET_CAIP2, LOW_BALANCE_CCD } from './scheme.mjs';
import { createHostedFacilitator, HOSTED_FACILITATOR_DEFAULT_URL } from './hosted.mjs';
import { verifyPayableHostedFirst, settlePayableHostedFirst, FALLBACK_ELIGIBLE_CODES } from './hosted-payonce.mjs';
import { OWNER_ADDRESS } from '../send.mjs';

const PORT = Number(process.argv[2] ?? process.env.FACILITATOR_PORT ?? 8091);
const LEDGER_PATH = fileURLToPath(new URL('../../test/facilitator-ledger.jsonl', import.meta.url));

// Hosted mode: the key comes ONLY from the process env — this file never
// reads any .env file or any other credential. Set FACILITATOR_MODE to
// 'hosted' or 'self-hosted' to override the default (hosted when a key is
// present, self-hosted otherwise).
//
// Mode validation (fail closed at STARTUP — the server never starts in a
// mode it is not actually running, and /health can never misreport it):
//   - any FACILITATOR_MODE other than 'hosted'/'self-hosted' (including an
//     empty string) throws: the process exits with a clear error instead of
//     silently picking a path.
//   - FACILITATOR_MODE=hosted without a key throws: "hosted" with no key
//     would otherwise run self-hosted-only while claiming to be hosted.
//   - the EFFECTIVE mode is what /health reports (facilitatorMode) and what
//     the server runs; the requested value is also reported
//     (facilitatorModeRequested) for operator transparency.
const HOSTED_API_KEY_RAW = process.env.X402_FACILITATOR_API_KEY ?? null;
// A whitespace-only key is no key (FIXBACK2 OB-2): trim, and treat a
// blank-after-trim as absent, so MODE=hosted + ' ' refuses to start
// instead of starting hosted and failing closed only at first /verify.
const HOSTED_API_KEY = HOSTED_API_KEY_RAW && HOSTED_API_KEY_RAW.trim() ? HOSTED_API_KEY_RAW.trim() : null;
const FACILITATOR_MODE_REQUESTED = process.env.FACILITATOR_MODE ?? null;
if (FACILITATOR_MODE_REQUESTED !== null && FACILITATOR_MODE_REQUESTED !== 'hosted' && FACILITATOR_MODE_REQUESTED !== 'self-hosted') {
  throw new Error(`FACILITATOR_MODE must be 'hosted' or 'self-hosted', got '${FACILITATOR_MODE_REQUESTED}' — refusing to start (a bogus mode must never silently pick a path)`);
}
const FACILITATOR_MODE = FACILITATOR_MODE_REQUESTED ?? (HOSTED_API_KEY ? 'hosted' : 'self-hosted');
if (FACILITATOR_MODE === 'hosted' && !HOSTED_API_KEY) {
  throw new Error('FACILITATOR_MODE=hosted requires X402_FACILITATOR_API_KEY in the process env — refusing to start (hosted mode with no key would silently run self-hosted while claiming to be hosted)');
}
const hosted = FACILITATOR_MODE === 'hosted'
  ? createHostedFacilitator({ apiKey: HOSTED_API_KEY, baseUrl: process.env.X402_FACILITATOR_URL ?? HOSTED_FACILITATOR_DEFAULT_URL })
  : null;

const facilitator = createFacilitator();
const limiter = new RateLimiter();
const client = grpcClient();

function ledgerSize() {
  if (!existsSync(LEDGER_PATH)) return 0;
  return readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean).length;
}
function appendLedger(entry) {
  mkdirSync(fileURLToPath(new URL('../../test/', import.meta.url)), { recursive: true });
  appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');
}
// Ledger append with one immediate retry. Returns { ok: true } or
// { ok: false, message }. FIXBACK2 OB-1: a ledger-write failure must NOT
// turn a CONFIRMED settle into an opaque HTTP 500 — the settle happened,
// the caller must be told so, with the ledger failure flagged.
function appendLedgerSafe(entry) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      appendLedger(entry);
      return { ok: true };
    } catch (e) {
      if (attempt === 1) return { ok: false, message: String(e.message).slice(0, 200) };
    }
  }
  return { ok: false, message: 'ledger append failed' };
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
        facilitatorMode: FACILITATOR_MODE, // EFFECTIVE mode — the mode the server is actually running
        facilitatorModeRequested: FACILITATOR_MODE_REQUESTED ?? 'default',
        hostedConfigured: hosted !== null,
        hostedBaseUrl: hosted?.baseUrl ?? null,
        sponsorBalanceMicroCcd: bal.microCcd, sponsorBalanceCcd: bal.ccd,
        lowBalanceWarning: bal.low, lowBalanceThresholdCcd: LOW_BALANCE_CCD,
        rateLimit: { maxRequests: limiter.maxRequests, windowMs: limiter.windowMs },
        ledgerEntries: ledgerSize(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/supported') {
      // Hosted mode: advertise the HOSTED feePayer/signers, so clients build
      // payloads naming the hosted sponsor. On hosted TRANSPORT failure
      // ONLY (FALLBACK_ELIGIBLE_CODES: hosted_unreachable,
      // hosted_unavailable, hosted_bad_response), fall back to the
      // self-hosted shape, labelled as fallback. A fail-closed hosted error
      // (401/403 auth, 400, 404, 429, or any unmapped 4xx/3xx as
      // hosted_unexpected_status) NEVER falls back: it returns HTTP 502
      // with the hosted code, so a revoked key or a hosted refusal can never
      // be papered over by advertising the OWNER as feePayer (FIXBACK3
      // MF-X402-FB2-A1: fake 422 and fake 401 both fell back here before,
      // because this handler caught ANY error and never consulted the
      // fallback taxonomy).
      if (hosted) {
        try {
          const sup = await hosted.supported();
          return send(res, 200, { ...sup, facilitator: 'hosted' });
        } catch (e) {
          const code = e?.code ?? 'hosted_error';
          if (FALLBACK_ELIGIBLE_CODES.has(code)) {
            return send(res, 200, {
              scheme: 'exact', network: TESTNET_CAIP2,
              extra: facilitator.scheme.getExtra(TESTNET_CAIP2),
              signers: facilitator.scheme.getSigners(TESTNET_CAIP2),
              facilitator: 'self-hosted-fallback', fallbackReason: code,
            });
          }
          return send(res, 502, {
            error: 'hosted_error', code,
            message: `hosted /supported failed (${code}); refusing to advertise a fallback feePayer`,
            facilitator: 'hosted',
          });
        }
      }
      return send(res, 200, {
        scheme: 'exact', network: TESTNET_CAIP2,
        extra: facilitator.scheme.getExtra(TESTNET_CAIP2),
        signers: facilitator.scheme.getSigners(TESTNET_CAIP2),
        facilitator: 'self-hosted',
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
        // Hosted-first when configured (see hosted-payonce.mjs for the
        // precedence rules); self-hosted-only without the key.
        const out = hosted
          ? await verifyPayableHostedFirst({ hosted, selfHosted: facilitator, grpc: client, payload, requirements, payableId, expectedStatus })
          : await payonceVerify(facilitator, payload, requirements, { payableId, expectedStatus });
        return send(res, 200, hosted ? out : { ...out, facilitator: 'self-hosted' });
      }
      const out = hosted
        ? await settlePayableHostedFirst({ hosted, grpc: client, payload, requirements, payableId, expectedStatus })
        : await payonceSettle(facilitator, payload, requirements, { payableId, expectedStatus });
      if (out.success) {
        const led = appendLedgerSafe({
          at: new Date().toISOString(), network: out.network ?? facilitator.network,
          facilitator: out.facilitator ?? (hosted ? 'hosted' : 'self-hosted'),
          payableId, payer: out.payer, transaction: out.transaction,
          amount: requirements.amount, asset: requirements.asset, payTo: requirements.payTo,
        });
        // The settle SUCCEEDED on chain; a ledger failure is flagged on the
        // (still 200) response, never masked as an HTTP 500 (FIXBACK2 OB-1).
        if (!led.ok) return send(res, 200, { ...out, ledgerError: true, ledgerMessage: led.message });
      }
      return send(res, 200, out);
    }
    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    return send(res, 500, { error: 'internal', message: String(e.message).slice(0, 300) });
  }
});

server.listen(PORT, () => {
  console.log(`PayOnce facilitator listening on http://localhost:${PORT} (testnet, mode ${FACILITATOR_MODE}, self-hosted sponsor ${OWNER_ADDRESS.slice(0, 8)}…${hosted ? `, hosted ${hosted.baseUrl}` : ''})`);
});
