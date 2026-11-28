// PayOnce API — Verification of Payee + sponsored relayer routes.
//   GET  /api/vop/check?seller=&payee=&name=[&country=&buyer=]   check_payee (also POST with JSON)
//   POST /api/vop/proofs        { payee, presentation, version }  keyless verify + store by anchor
//   GET  /api/vop/proofs/:anchor                                  the stored presentation (re-verifiable)
//   GET  /api/vop/payee?seller=&payee=                            the raw payee-book record
//   GET  /api/vop/payable?seller=&id=                             a v3 payable (payee + payee_version from chain)
//   GET  /api/vop/config                                          contract, codes, verdicts
//   GET  /api/relay/config                                        what the relayer sponsors
//   POST /api/relay/build       { sender, entrypoint, parameter | kind:'token', recipient, amount, memo }
//   POST /api/relay/submit      { transaction }                   sender-signed -> sponsor co-signs -> submit once
// The MCP / npm / GitHub Action packaging wraps GET /api/vop/check (see the handoff).
import { VerifiablePresentationV1 } from '@concordium/web-sdk';
import { createVopService, VopError } from './vop-service.mjs';
import { createRelayer, RelayError } from './relayer.mjs';
import { V3, v3Label, V3_ERRORS, getPayeeRecord, getConfigV3, getPayableV3 } from './vop-chain.mjs';
import { VERDICT, BUSINESS_IDPS } from './vop.mjs';
import { vClient, VERIFIER_URL } from './consent.mjs';
import { signers } from './chain-v2.mjs';
import { kvGet, kvPut } from './store.mjs';

const toPlain = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));

export async function verifyPresentationKeyless({ version, presentation }) {
  if (version === 'v0') {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30_000);
    try {
      const r = await fetch(VERIFIER_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(presentation), signal: ctl.signal });
      return r.ok ? { ok: true } : { ok: false, reason: `verifier HTTP ${r.status}` };
    } catch (e) { return { ok: false, reason: `verifier unreachable (${String(e?.message ?? e).slice(0, 80)})` }; } finally { clearTimeout(t); }
  }
  let pres;
  try { pres = VerifiablePresentationV1.fromJSON(presentation); } catch (e) { return { ok: false, reason: `malformed V1 presentation (${String(e?.message ?? e).slice(0, 80)})` }; }
  // The public node rate-limits (HTTP 429 / UNAVAILABLE): that is "no answer", not "invalid". Retry with backoff.
  let last = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await VerifiablePresentationV1.verifyWithNode(pres, vClient(), 'Testnet');
      if (r?.type === 'success') return { ok: true };
      last = { ok: false, reason: String(r?.error?.message ?? r?.error ?? 'node verification failed').slice(0, 200) };
    } catch (e) { last = { ok: false, reason: String(e?.message ?? e).slice(0, 200) }; }
    if (!/429|UNAVAILABLE|RESOURCE_EXHAUSTED|ECONNRESET|ETIMEDOUT/.test(last.reason)) return last;
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  return { ...last, transient: true };
}

export const vop = createVopService({
  grpc: async () => vClient(),
  kv: { get: kvGet, put: kvPut },
  verifyPresentation: verifyPresentationKeyless,
  network: 'Testnet',
});

export const relayer = createRelayer({
  grpc: async () => vClient(),
  sponsor: async () => (await signers()).owner,
});

export function vopRoutes({ sendJson, apiError, readBody, clientIp, hitWindow }) {
  const wrap = (fn) => async (req, res, m) => {
    try {
      return sendJson(res, 200, toPlain(await fn(req, res, m)));
    } catch (e) {
      if (e instanceof VopError || e instanceof RelayError) return apiError(res, e.status, e.code, 'app', e.message);
      if (/body too large|invalid JSON/.test(e?.message ?? '')) return apiError(res, 400, 'bad_request', 'app', e.message);
      return apiError(res, 502, 'vop_upstream', 'node', `The chain did not answer (${String(e?.message ?? e).slice(0, 200)}).`, { retryable: true });
    }
  };
  const limited = (key, perMin) => async (req) => {
    const w = await hitWindow(`${key}:${clientIp(req)}`, 60_000, perMin);
    if (!w.allowed) throw new VopError(429, 'rate_limited', 'Too many requests, slow down.');
  };
  const qs = (req) => Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const relayLimited = async (req) => {
    const w = await hitWindow(`relay:${clientIp(req)}`, 60_000, 12);
    if (!w.allowed) throw new RelayError(429, 'rate_limited', 'Too many relay requests, slow down.');
  };
  return [
    ['GET', /^\/api\/vop\/config$/, wrap(async () => ({
      contract: { address: v3Label(), name: V3.name, module_ref: V3.moduleRef, config: await getConfigV3(vClient()).catch(() => null) },
      verdicts: Object.values(VERDICT), business_identity_providers: BUSINESS_IDPS, reject_codes: V3_ERRORS,
      check: 'GET /api/vop/check?seller=<acct>&payee=<acct>&name=<invoice payee name>[&buyer=<acct>]',
      rule: 'An agent pays only when payable=true: verdict MATCH, payee bound by its own signature, cooling-off over, proof anchored and re-verified with the node.',
    }))],
    ['GET', /^\/api\/vop\/check$/, wrap(async (req) => { await limited('vop:check', 30)(req); const q = qs(req); return vop.check({ seller: q.seller, payee: q.payee, legal_name: q.name ?? q.legal_name, country: q.country, buyer: q.buyer }); })],
    ['POST', /^\/api\/vop\/check$/, wrap(async (req) => { await limited('vop:check', 30)(req); return vop.check(await readBody(req)); })],
    ['POST', /^\/api\/vop\/proofs$/, wrap(async (req) => { await limited('vop:proof', 6)(req); return vop.submitProof(await readBody(req, 256 * 1024)); })],
    ['GET', /^\/api\/vop\/proofs\/([0-9a-f]{64})$/, wrap(async (req, res, m) => { await limited('vop:proofget', 30)(req); return vop.getProof(m[1]); })],
    ['GET', /^\/api\/vop\/payee$/, wrap(async (req) => {
      await limited('vop:payee', 30)(req); const q = qs(req);
      if (!/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(q.seller ?? '') || !/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(q.payee ?? '')) throw new VopError(400, 'bad_address', 'seller and payee are account addresses.');
      return { contract: v3Label(), record: await getPayeeRecord(vClient(), q.seller, q.payee) };
    })],
    ['GET', /^\/api\/vop\/payable$/, wrap(async (req) => {
      await limited('vop:payable', 60)(req); const q = qs(req);
      if (!/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(q.seller ?? '') || !/^\d{1,19}$/.test(q.id ?? '')) throw new VopError(400, 'bad_key', 'seller (account) and id (integer) are required.');
      return { contract: v3Label(), payable: await getPayableV3(vClient(), q.seller, q.id) };
    })],
    ['GET', /^\/api\/relay\/config$/, wrap(() => relayer.config())],
    ['POST', /^\/api\/relay\/build$/, wrap(async (req) => { await relayLimited(req); return relayer.build(await readBody(req)); })],
    ['POST', /^\/api\/relay\/submit$/, wrap(async (req) => { await relayLimited(req); return relayer.submit(await readBody(req, 128 * 1024)); })],
  ];
}
