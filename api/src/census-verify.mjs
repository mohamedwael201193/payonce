// Sample verification of the census: the census attributes each account's identity provider from CCDExplorer's public page.
// This module re-reads `getAccountInfo` from a Concordium node for EVERY business-identity account plus a seeded random sample
// of the rest, and reports how many attributions agree. One implementation for three callers:
//   GET /api/census/verify          (the API host reaches the nodes; cached, rate-limited, read-only)
//   tools/census/verify-sample.mjs  (CLI / GitHub Action; writes tools/census/census_verification.json)
//   unit tests (injected readers, offline)
// The result says exactly what was checked (a sample), never "the whole census is verified".
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { AccountAddress } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';

export const SCHEMA = 'payonce-census-verification/v1';
export const IDP_NAMES = Object.freeze({
  mainnet: { 1: 'Notabene', 2: 'Digital Trust Solutions', 3: 'Global FinReg' },
  testnet: { 0: 'Concordium testnet IP', 3: 'Digital Trust Solutions TestNet', 4: 'Global FinReg Testnet', 5: 'Dataspike' },
});
export const NODE_HOSTS = Object.freeze({ mainnet: 'grpc.mainnet.concordium.software', testnet: 'grpc.testnet.concordium.com' });

/** RFC 4180-ish CSV -> array of objects (handles quoted fields, embedded commas/newlines, CRLF). */
export function parseCsv(text) {
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const [head, ...rest] = rows;
  return rest.filter((r) => r.length === head.length).map((r) => Object.fromEntries(r.map((v, i) => [head[i], v])));
}

const setOf = (s) => [...new Set(String(s ?? '').split('|').map((x) => x.trim()).filter(Boolean))].sort();
const isBusiness = (names) => names.some((n) => /^Global FinReg/.test(n));

/** The accounts the census attributes an identity to: owner and payee (agentWallet, or owner when unset). */
export function censusAccounts(rows) {
  const m = new Map();
  for (const r of rows) {
    m.set(r.owner_account, r.owner_idp);
    m.set(r.agent_wallet || r.owner_account, r.agent_wallet ? r.payee_idp : r.owner_idp);
  }
  return m;
}

export function seededRandom(seed) { let s = Number(seed) >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

/** Pure: compare census attributions with what a node says. `readIdps(addr)` -> array of provider names (or throws). */
export async function verifyNetwork({ net, rows, readIdps, n = 25, seed = 7, concurrency = 4 }) {
  const m = censusAccounts(rows); const all = [...m.keys()].sort();
  const biz = all.filter((a) => isBusiness(setOf(m.get(a))));
  const rnd = seededRandom(seed); const chosen = new Set(biz);
  const target = Math.min(all.length, biz.length + n);
  while (chosen.size < target) chosen.add(all[Math.floor(rnd() * all.length)]);
  const list = [...chosen]; const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (next < list.length) {
      const a = list[next++]; const census = setOf(m.get(a));
      try {
        const node = [...new Set(await readIdps(a))].sort();
        results.push({ account: a, census, node, business_in_census: isBusiness(census), result: !census.length ? 'census_unattributed' : census.join('|') === node.join('|') ? 'agree' : 'mismatch' });
      } catch (e) { results.push({ account: a, census, node: null, business_in_census: isBusiness(census), result: 'node_error', error: String(e?.message ?? e).slice(0, 100) }); }
    }
  }));
  results.sort((x, y) => x.account.localeCompare(y.account));
  const c = (k) => results.filter((r) => r.result === k).length;
  const checked = c('agree') + c('mismatch');
  return {
    accounts_in_census: all.length, business_accounts_in_census: biz.length, business_accounts_checked: results.filter((r) => r.business_in_census).length,
    sample_size: results.length, agree: c('agree'), mismatch: c('mismatch'), node_errors: c('node_error'), census_unattributed: c('census_unattributed'),
    agreement_rate: checked ? Math.round((1000 * c('agree')) / checked) / 1000 : null,
    business_agree: results.filter((r) => r.business_in_census && r.result === 'agree').length,
    accounts: results,
  };
}

const clients = {};
export function nodeClient(net) {
  const env = process.env;
  const host = net === 'mainnet' ? (env.MAINNET_GRPC_HOST ?? NODE_HOSTS.mainnet) : (env.TESTNET_GRPC_HOST ?? NODE_HOSTS.testnet);
  return (clients[net] ??= new ConcordiumGRPCNodeClient(host, 20000, credentials.createSsl()));
}
export async function nodeIdps(net, address, client = nodeClient(net)) {
  const info = await client.getAccountInfo(AccountAddress.fromBase58(address));
  return Object.values(info.accountCredentials ?? {}).map((x) => { const i = Number(x.value?.contents?.ipIdentity); return IDP_NAMES[net][i] ?? `idp ${i}`; });
}

/** Whole run: both networks. `rowsByNet` = { mainnet: [...], testnet: [...] } parsed from census_*.csv. */
export async function runVerification({ rowsByNet, censusGeneratedAt = null, readIdps = (net) => (a) => nodeIdps(net, a), n = 25, seed = 7, runBy = 'api', now = Date.now }) {
  const networks = {};
  for (const net of ['mainnet', 'testnet']) networks[net] = await verifyNetwork({ net, rows: rowsByNet[net], readIdps: readIdps(net), n, seed });
  const ok = Object.values(networks).every((x) => x.mismatch === 0 && x.node_errors === 0 && x.agree >= Math.min(n, 20));
  return {
    schema: SCHEMA, verified_at_utc: new Date(now()).toISOString(), run_by: runBy, census_generated_at_utc: censusGeneratedAt, seed, sample_per_network: n,
    node: { mainnet: process.env.MAINNET_GRPC_HOST ?? NODE_HOSTS.mainnet, testnet: process.env.TESTNET_GRPC_HOST ?? NODE_HOSTS.testnet },
    all_agree: ok, networks,
    scope: 'Identity-provider attribution only, for every business-identity account plus a seeded random sample of the other accounts. It does not verify badges, cards or the full census.',
    method: 'getAccountInfo from a Concordium node (gRPC) -> identity provider index of every credential -> provider name, compared with the CCDExplorer-derived attribution in census_*.csv.',
  };
}

// ---- GET /api/census/verify: load the committed CSVs (raw GitHub, bundled fallback), run, cache ----
const RAW_BASE = process.env.CENSUS_RAW_BASE ?? 'https://raw.githubusercontent.com/mohamedwael201193/payonce/main/tools/census/';
let cached = null; let inflight = null;
export async function loadAndVerify({ fetchImpl = fetch, readLocal, run = runVerification, now = Date.now, ttlMs = 30 * 60_000 } = {}) {
  if (cached && now() - cached.at < ttlMs) return { ...cached.value, cached: true };
  if (inflight) return inflight;
  inflight = (async () => {
    const get = async (f) => { try { const r = await fetchImpl(RAW_BASE + f, { signal: AbortSignal.timeout(20_000) }); if (r.ok) return await r.text(); } catch { /* bundled */ } return readLocal(f); };
    const rowsByNet = { mainnet: parseCsv(await get('census_mainnet.csv')), testnet: parseCsv(await get('census_testnet.csv')) };
    let gen = null; try { gen = JSON.parse(await get('census_public.json')).generated_at_utc ?? null; } catch { /* unknown */ }
    // the sample changes daily (seed = UTC date) so repeated visits widen the evidence, and any day can be re-derived
    const d = new Date(now()); const seed = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    const value = await run({ rowsByNet, censusGeneratedAt: gen, seed, runBy: 'api', now });
    cached = { at: now(), value }; return { ...value, cached: false };
  })().finally(() => { inflight = null; });
  return inflight;
}
export const _resetVerifyCache = () => { cached = null; inflight = null; };
