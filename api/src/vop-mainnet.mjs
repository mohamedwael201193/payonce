// check_payee, MAINNET mode (read-only, identity only).
//
//   GET /api/vop/check?network=mainnet&payee=<acct>&name=<invoice payee name>
//
// What it does: reads the payee account's credentials from a Concordium MAINNET node (identity provider, validity),
// classifies the account as business (Global FinReg, idp 3) or person (Notabene 1, Digital Trust Solutions 2), and lists
// the CIS-8004 mainnet registry agents the account owns. It returns the same four verdicts and the same evidence hash
// as the testnet check, from the same decision function.
//
// What it cannot do (said in every response): the PayOnce v3 payee book exists on testnet only, so there is no payee
// signature binding the account to a legal name and the answer is never MATCH and never `payable`. A business identity
// proves *a company* stands behind the account, not *which* company. The legal name needs a zero-knowledge name proof
// (VoP stage 2), which no mainnet account has published to us.
//
// The node read uses gRPC (the API host reaches the public mainnet node). If gRPC fails, it falls back to the public
// CCDExplorer account page (labelled `source: ccdexplorer`), so a node outage degrades the answer's source, not its honesty.
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { AccountAddress } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
import { decideVop, evidenceHash } from './vop.mjs';
import { VopError } from './vop-service.mjs';

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{50}$/;
export const MAINNET_IDPS = Object.freeze({ 1: 'Notabene', 2: 'Digital Trust Solutions', 3: 'Global FinReg' });
const IDP_BY_NAME = Object.fromEntries(Object.entries(MAINNET_IDPS).map(([i, n]) => [n, Number(i)]));
const REGISTRY_MCP = process.env.AGENT_REGISTRY_MCP_URL ?? 'https://agent-registry-mcp.concordium.com/mcp';
const jsonSafe = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));

let mainnetClient = null;
export function mainnetGrpc() {
  if (!mainnetClient) mainnetClient = new ConcordiumGRPCNodeClient(process.env.MAINNET_GRPC_HOST ?? 'grpc.mainnet.concordium.software', Number(process.env.MAINNET_GRPC_PORT ?? 20000), credentials.createSsl());
  return mainnetClient;
}

/** Credentials with identity provider + validity from an AccountInfo JSON (validTo / createdAt are "YYYYMM"). */
export function credentialDetailsOf(accountInfoJson) {
  const out = [];
  for (const entry of Object.values(accountInfoJson?.accountCredentials ?? {})) {
    const c = entry?.value?.contents ?? entry?.contents ?? {};
    const idp = c.ipIdentity ?? c.ipId ?? null;
    if (idp == null) continue;
    const ym = (v) => { const s = String(v ?? ''); return /^\d{6}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : (v?.year != null ? `${v.year}-${String(v.month).padStart(2, '0')}` : null); };
    out.push({ credId: (c.credId ?? c.regId) ? String(c.credId ?? c.regId).toLowerCase() : null, idp: Number(idp), validTo: ym(c.policy?.validTo), createdAt: ym(c.policy?.createdAt) });
  }
  return out;
}

export async function identityFromNode(c, address) {
  try {
    const info = jsonSafe(await c.getAccountInfo(AccountAddress.fromBase58(address)));
    return { exists: true, address, credentials: credentialDetailsOf(info), source: 'node' };
  } catch (e) {
    if (/not found|NOT_FOUND/i.test(String(e?.message ?? e)) || Number(e?.code) === 5) return { exists: false, address, credentials: [], source: 'node' };
    throw e;
  }
}

/** Fallback: public CCDExplorer account page ("ID Provider <name> Credential ID|Created At ..."). */
export async function identityFromExplorer(address, fetchImpl = fetch) {
  const r = await fetchImpl(`https://ccdexplorer.io/mainnet/account/${address}`, { headers: { 'user-agent': 'payonce-check-payee/1.0' }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) return { exists: false, address, credentials: [], source: 'ccdexplorer' };
  if (!r.ok) throw new Error(`explorer HTTP ${r.status}`);
  const text = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const names = [...text.matchAll(/ID Provider (.+?) (?:Credential ID|Created At)/g)].map((m) => m[1].trim());
  const creds = names.map((n) => ({ credId: null, idp: IDP_BY_NAME[n] ?? -1, validTo: null, createdAt: null }));
  if (!creds.length) throw new Error('explorer page had no credential block');
  return { exists: true, address, credentials: creds, source: 'ccdexplorer' };
}

async function registryAgentsOwnedBy(address, fetchImpl = fetch) {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agents_by_owner', arguments: { owner_account: address, network: 'mainnet', limit: 50 } } };
  const r = await fetchImpl(REGISTRY_MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  let t = await r.text();
  if (/^(event|data):/.test(t)) t = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop();
  const res = JSON.parse(t)?.result;
  const sc = res?.structuredContent ?? JSON.parse(res?.content?.[0]?.text ?? 'null');
  return { total: sc?.total ?? 0, agents: (sc?.agents ?? []).slice(0, 20).map((a) => ({ token_id: a.token_id, status: a.status, agent_wallet: a.agent_wallet ?? null, agent_uri: a.agent_uri ?? null })) };
}

/** deps: { node(): grpc client, explorer(addr), registry(addr), now() } — all injectable for tests. */
export function createMainnetCheck(deps = {}) {
  const now = deps.now ?? Date.now;
  const node = deps.node ?? (() => mainnetGrpc());
  const explorer = deps.explorer ?? identityFromExplorer;
  const registry = deps.registry ?? registryAgentsOwnedBy;
  return async function checkMainnet(input) {
    const payee = String(input?.payee ?? '');
    const legalName = String(input?.legal_name ?? input?.name ?? '').trim();
    if (!ADDR.test(payee)) throw new VopError(400, 'bad_address', 'payee must be a Concordium account address.');
    if (!legalName || legalName.length > 200) throw new VopError(400, 'bad_name', 'legal_name (the payee name on the invoice) is required, up to 200 characters.');
    let account; let nodeError = null;
    try { account = await identityFromNode(node(), payee); } catch (e) { nodeError = String(e?.message ?? e).slice(0, 120); }
    if (!account) {
      try { account = await explorer(payee); } catch (e) { throw new VopError(503, 'mainnet_unreachable', `Neither the mainnet node nor the public explorer answered (${nodeError}; ${String(e?.message ?? e).slice(0, 80)}). No verdict given.`); }
    }
    let reg = null;
    try { reg = await registry(payee); } catch { reg = null; }
    const result = decideVop({ invoice: { legal_name: legalName, country: input?.country ?? null }, account, proof: null, book: null, nowMs: now(), network: 'Mainnet' });
    const nowYm = new Date(now()).toISOString().slice(0, 7);
    const expired = account.credentials.filter((c) => c.validTo && c.validTo < nowYm);
    if (account.exists) {
      result.checks.push({ id: 'credential_validity', ok: account.credentials.length > 0 && expired.length === 0, detail: account.credentials.some((c) => c.validTo) ? `credential valid to ${account.credentials.map((c) => c.validTo).filter(Boolean).join(', ')}${expired.length ? ' (EXPIRED)' : ''}` : 'validity not readable from the explorer fallback' });
      if (expired.length) result.reasons.push('An identity credential on this account has expired; an expired identity cannot stand behind a payee.');
    }
    result.checks.push({ id: 'payee_book', ok: false, detail: 'no PayOnce payee book on mainnet (v3 is testnet-only): the account is not bound to a legal name by its own signature' });
    result.payable = false;
    result.reasons.push('Mainnet mode is identity-only: a business identity proves a company stands behind the account, not which company. A MATCH needs a payee-signed name binding (testnet v3) or a zero-knowledge name proof.');
    const idps = [...new Set(account.credentials.map((c) => c.idp))];
    const subject = {
      network: 'Mainnet', mode: 'identity_only', source: account.source, node_error: nodeError, payee, invoice_name: legalName,
      identity_providers: idps.map((i) => ({ index: i, name: MAINNET_IDPS[i] ?? 'unknown' })),
      registry_agents_owned: reg,
    };
    result.subject = subject;
    return {
      verdict: result.verdict, payable: false, verified_name: null, verified_country: null, identity_kind: result.identity_kind, standin: false,
      mode: 'identity_only', reasons: result.reasons, checks: result.checks, subject, evidence_hash: evidenceHash(result), checked_at: new Date(now()).toISOString(),
    };
  };
}
export const checkMainnet = createMainnetCheck();
