#!/usr/bin/env node
// PayOnce live claims checker: every public claim -> PASS / FAIL against the live testnet. Read-only, no keys.
//   node tools/census/check-live.mjs [--json] [--api https://...] [--site https://...]
// Uses only HTTP (wallet-proxy, official Agent Registry service, PayOnce API), so it also works behind networks that block gRPC.
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const API = arg('--api', 'https://payonce-api-n98a.onrender.com');
const SITE = arg('--site', 'https://payonce-tau.vercel.app');
const WP = 'https://wallet-proxy.testnet.concordium.com';
const REG = 'https://agent-registry-mcp.concordium.com';
const JSON_OUT = process.argv.includes('--json');
const j = async (u, o) => { const r = await fetch(u, { signal: AbortSignal.timeout(45000), ...o }); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b }; };
const retry = async (f, n = 4) => { let e; for (let i = 0; i < n; i++) { try { return await f(); } catch (x) { e = x; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); } } throw e; };
const claims = [];
const claim = (id, text, fn) => claims.push({ id, text, fn });

claim('L1', 'The app and the proof page are live (HTTP 200)', async () => {
  const r = await Promise.all([`${SITE}/app`, `${SITE}/app/proof`].map((u) => retry(() => fetch(u, { signal: AbortSignal.timeout(30000) }))));
  return { ok: r.every((x) => x.status === 200), detail: r.map((x) => x.status).join(',') };
});
claim('L2', 'The API is up and runs on testnet only', async () => {
  const { status, body } = await retry(() => j(`${API}/api/config`));
  return { ok: status === 200 && !/mainnet/i.test(JSON.stringify(body.network ?? body.chain ?? 'testnet')), detail: `HTTP ${status}` };
});
claim('L3', 'Payable registry v3 is <13172,0> and answers the four VoP verdicts', async () => {
  const { status, body } = await retry(() => j(`${API}/api/vop/config`));
  const v = body?.verdicts ?? [];
  return { ok: status === 200 && body?.contract?.address === '<13172,0>' && ['MATCH', 'CLOSE_MATCH', 'NO_MATCH', 'UNVERIFIED'].every((x) => v.includes(x)), detail: `${body?.contract?.address} ${v.join('/')}` };
});
claim('L4', 'check_payee answers a verdict with an evidence hash for any account', async () => {
  const q = new URLSearchParams({ seller: '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr', payee: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', name: 'Check Live Test' });
  const { status, body } = await retry(() => j(`${API}/api/vop/check?${q}`));
  return { ok: status === 200 && ['MATCH', 'CLOSE_MATCH', 'NO_MATCH', 'UNVERIFIED'].includes(body?.verdict) && /^[0-9a-f]{64}$/.test(body?.evidence_hash ?? ''), detail: `${body?.verdict} ${String(body?.evidence_hash).slice(0, 12)}` };
});
claim('L5', 'check_payee refuses an invoice name that nothing stands behind (never MATCH for an unproven name)', async () => {
  const q = new URLSearchParams({ seller: '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr', payee: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', name: 'Totally Unrelated Corp' });
  const { body } = await retry(() => j(`${API}/api/vop/check?${q}`));
  return { ok: body?.verdict !== 'MATCH' && body?.payable === false, detail: `${body?.verdict} payable=${body?.payable}` };
});
const finalized = async (h) => (await retry(() => j(`${WP}/v0/submissionStatus/${h}`))).body;
claim('L6', 'A real CCD payment (payable 10) finalized and succeeded: 7c204f0b…', async () => {
  const b = await finalized('7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197');
  return { ok: b.status === 'finalized' && b.outcome === 'success', detail: `${b.status}/${b.outcome}` };
});
claim('L7', 'The chain refused an unlisted seller with code -19: e8e3d588…', async () => {
  const b = await finalized('e8e3d588817c80f58d20589752bf72f61896f8430e95bd880f9b06c6647688b5');
  return { ok: b.status === 'finalized' && b.outcome === 'reject' && /reason -19\b/.test(b.rejectReason ?? ''), detail: `${b.outcome} ${b.rejectReason ?? ''}` };
});
claim('L8', 'The 18+ check anchors (request 0cd44ea0…, result bf5a7bf4…) are finalized registerData transactions', async () => {
  const bs = await Promise.all(['0cd44ea04e380c1bfd23b2fc8c79a7474ac6088d34dedf7159499320be7b8ca2', 'bf5a7bf445b53d4b2e62407f55639f2f0b897bc983f223f2cb0491c605c1bb19'].map(finalized));
  return { ok: bs.every((b) => b.status === 'finalized' && b.outcome === 'success' && b.registeredData), detail: bs.map((b) => b.status).join(',') };
});
claim('L9', 'Four PayOnce agents hold a valid official Concordium badge (1476, 1506, 1488, 1554)', async () => {
  const toks = ['JyP9XawpXHMjTN5ocrA5a', 'JyP9Y9nGU4KaM7DBDXRgm', 'JyP9Xp5bhbLsQrw7yTyph', 'JyP9UE8M6sTcxSaorAr8W'];
  const rs = await Promise.all(toks.map((t) => retry(() => j(`${REG}/v1/check-badge/${t}?network=testnet`))));
  const ok = rs.map((r) => r.body?.agents?.[0]?.badge_valid === true || r.body?.badge_valid === true);
  return { ok: ok.every(Boolean), detail: ok.join(',') };
});
claim('L10', 'Live stats are consistent (paid ≤ total, none stale)', async () => {
  const { body: s } = await retry(() => j(`${API}/api/stats`));
  return { ok: s.paid_total <= s.payables_total && s.stale === false, detail: `${s.paid_total}/${s.payables_total} stale=${s.stale}` };
});
claim('L11', 'Census: the published numbers match a fresh read of the official registry total', async () => {
  let pub = await j(`${SITE}/census.json`).catch(() => ({ status: 0 }));
  if (pub.status !== 200) pub = await retry(() => j('https://raw.githubusercontent.com/mohamedwael201193/payonce/main/tools/census/census_public.json'));
  const st = (await retry(() => j('https://agent-registry-indexer.concordium.com/status'))).body;
  if (pub.status !== 200) return { ok: false, detail: 'census_public.json not reachable' };
  const t = pub.body?.networks?.testnet?.agents_total, m = pub.body?.networks?.mainnet?.agents_total;
  return { ok: t <= st.networks.testnet.agents && m <= st.networks.mainnet.agents && st.networks.testnet.agents - t < 400 && st.networks.mainnet.agents - m < 800, detail: `census ${t}/${m} vs indexer ${st.networks.testnet.agents}/${st.networks.mainnet.agents}` };
});

claim('L12', 'Mainnet check_payee is read-only and identity-only: never MATCH, never payable', async () => {
  const q = new URLSearchParams({ network: 'mainnet', payee: '4VgCemxxqBmz5nzxPWYQUqFgKtLkecFb6Jdx4D73bBTCfiQXEc', name: 'Check Live Test' });
  const { status, body } = await retry(() => j(`${API}/api/vop/check?${q}`));
  return { ok: status === 200 && body?.mode === 'identity_only' && body?.payable === false && body?.verdict !== 'MATCH' && /^[0-9a-f]{64}$/.test(body?.evidence_hash ?? ''), detail: `HTTP ${status} ${body?.verdict} ${body?.identity_kind} via ${body?.subject?.source}` };
});
claim('L13', 'GET /api/census serves the census and it is fresh (refreshed within 14 h)', async () => {
  const { status, body } = await retry(() => j(`${API}/api/census`));
  return { ok: status === 200 && body?.schema === 'payonce-vop-census/v1' && body?.served?.stale === false, detail: `HTTP ${status} source ${body?.served?.source} age ${body?.served?.age_hours} h` };
});

const out = [];
for (const c of claims) {
  let r; try { r = await c.fn(); } catch (e) { r = { ok: false, detail: `error: ${e.message}` }; }
  out.push({ id: c.id, claim: c.text, result: r.ok ? 'PASS' : 'FAIL', detail: r.detail });
  if (!JSON_OUT) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.text}  [${r.detail}]`);
}
const pass = out.filter((x) => x.result === 'PASS').length;
if (JSON_OUT) console.log(JSON.stringify({ checked_at: new Date().toISOString(), pass, total: out.length, claims: out }, null, 1));
else console.log(`\n${pass}/${out.length} claims PASS`);
process.exit(pass === out.length ? 0 : 1);
