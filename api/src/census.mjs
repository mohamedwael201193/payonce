// GET /api/census: the Verification-of-Payee census of the Concordium Agent Registry (data produced by tools/census,
// refreshed every 6 h by .github/workflows/census.yml). Served from the freshest of: raw GitHub main, the copy bundled
// with this deploy. Shape = tools/census/census_public.json (contract in the V14 handoff).
import { readFileSync } from 'node:fs';
const RAW = process.env.CENSUS_URL ?? 'https://raw.githubusercontent.com/mohamedwael201193/payonce/main/tools/census/census_public.json';
const LOCAL = new URL('../../tools/census/census_public.json', import.meta.url);
const TTL_MS = 10 * 60_000;
const STALE_AFTER_H = 14; // 6 h cadence + one missed run + slack
let cache = null;
export async function loadCensus({ fetchImpl = fetch, now = Date.now, readLocal = () => JSON.parse(readFileSync(LOCAL, 'utf8')) } = {}) {
  if (cache && now() - cache.at < TTL_MS) return cache.value;
  let data = null; let source = 'github';
  try {
    const r = await fetchImpl(RAW, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) data = await r.json();
  } catch { /* fall through to the bundled copy */ }
  if (!data?.networks) { data = readLocal(); source = 'bundled'; }
  const gen = Date.parse(data.generated_at_utc);
  const age_hours = Number.isFinite(gen) ? Math.round(((now() - gen) / 3_600_000) * 10) / 10 : null;
  const value = { ...data, served: { source, served_at: new Date(now()).toISOString(), age_hours, stale: age_hours == null || age_hours > STALE_AFTER_H, refresh: 'every 6 hours (GitHub Action census.yml)' } };
  cache = { at: now(), value };
  return value;
}
export const _resetCensusCache = () => { cache = null; };
