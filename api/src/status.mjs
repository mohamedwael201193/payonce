// GET /api/status: one public JSON answering "is PayOnce up, and are the things its claims rest on still true?"
// Used by the status page, the keep-alive/monitor Action (.github/workflows/monitor.yml) and judges.
//   api            this process answers
//   census         the census data is fresh (refreshed within 14 h)
//   badges         the four PayOnce agents still hold a valid official Concordium badge (1476, 1506, 1488, and 1554 the check_payee service) (badge continuity)
//   registry       the official registry indexer answers
//   testnet_node / mainnet_node   the public nodes answer and are finalizing blocks
// Pure over injected readers (tests), cached 60 s so a status page cannot hammer the nodes or the registry.
export const AGENTS = Object.freeze([
  { token_id: 1476, token_address: 'JyP9XawpXHMjTN5ocrA5a', role: 'seller' },
  { token_id: 1506, token_address: 'JyP9Y9nGU4KaM7DBDXRgm', role: 'seller 2' },
  { token_id: 1488, token_address: 'JyP9Xp5bhbLsQrw7yTyph', role: 'buyer agent' },
  { token_id: 1554, token_address: 'JyP9UE8M6sTcxSaorAr8W', role: 'check_payee service' },
]);
const CHECK_BADGE = (t) => `https://agent-registry-mcp.concordium.com/v1/check-badge/${t}?network=testnet`;
const INDEXER = 'https://agent-registry-indexer.concordium.com/status';

const attempt = async (id, fn, required = true) => {
  const t0 = Date.now();
  try { const r = await fn(); return { id, required, ok: r.ok !== false, ms: Date.now() - t0, ...r }; }
  catch (e) { return { id, required, ok: false, ms: Date.now() - t0, detail: `error: ${String(e?.message ?? e).slice(0, 120)}` }; }
};
const getJson = async (fetchImpl, url, ms = 20_000) => { const r = await fetchImpl(url, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

export function createStatus({ fetchImpl = fetch, loadCensus, testnetNode, mainnetNode, now = Date.now, ttlMs = 60_000 } = {}) {
  let cache = null; let inflight = null;
  async function compute() {
    const badges = await Promise.all(AGENTS.map(async (a) => {
      try { const j = await getJson(fetchImpl, CHECK_BADGE(a.token_address)); const g = j?.agents?.[0] ?? j; return { ...a, valid: g?.badge_valid === true, issues: (g?.issues ?? []).map((i) => i.field ?? String(i)).slice(0, 5) }; }
      catch (e) { return { ...a, valid: null, issues: [`unreadable: ${String(e?.message ?? e).slice(0, 60)}`] }; }
    }));
    const checks = await Promise.all([
      attempt('api', async () => ({ detail: 'answering' })),
      attempt('census', async () => { const c = await loadCensus(); return { ok: c.served.stale === false, detail: `age ${c.served.age_hours} h, source ${c.served.source}`, age_hours: c.served.age_hours }; }),
      attempt('badges', async () => ({ ok: badges.every((b) => b.valid === true), detail: badges.map((b) => `${b.token_id}:${b.valid}`).join(' ') })),
      attempt('registry', async () => { const s = await getJson(fetchImpl, INDEXER); return { detail: `${s.networks?.testnet?.agents ?? '?'} testnet / ${s.networks?.mainnet?.agents ?? '?'} mainnet agents indexed` }; }, false),
      attempt('testnet_node', async () => testnetNode(), false),
      attempt('mainnet_node', async () => mainnetNode(), false),
    ]);
    return { schema: 'payonce-status/v1', checked_at: new Date(now()).toISOString(), ok: checks.filter((c) => c.required).every((c) => c.ok), degraded: checks.filter((c) => !c.required).some((c) => !c.ok), checks, badges,
      note: 'ok = the required checks pass (api, census freshness, badge continuity). degraded = an optional dependency (registry indexer, a public node) is not answering.' };
  }
  return async function status() {
    if (cache && now() - cache.at < ttlMs) return { ...cache.value, cached: true };
    if (!inflight) inflight = compute().then((v) => { cache = { at: now(), value: v }; return v; }).finally(() => { inflight = null; });
    return { ...(await inflight), cached: false };
  };
}
