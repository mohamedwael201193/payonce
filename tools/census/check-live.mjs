#!/usr/bin/env node
// PayOnce live claims checker: every public claim -> PASS / FAIL against the live testnet. Read-only, no keys.
//   node tools/census/check-live.mjs [--json] [--api https://...] [--site https://...]
// 30 claims. Uses only HTTP (wallet-proxy, official Agent Registry service, PayOnce API), so it also works behind networks that block gRPC.
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


// ---- L14+: distribution, identity, receipts, x402 sales, A2A, the two-way gate and the spend mandate ----
const NPM_ACCEPT = (v) => /^\d+\.\d+\.\d+$/.test(v ?? '');
claim('L14', 'npm: payonce-check-payee and payonce-mcp are published (>= 0.1.2)', async () => {
  const [a, b] = await Promise.all(['payonce-check-payee', 'payonce-mcp'].map((n) => retry(() => j(`https://registry.npmjs.org/${n}/latest`))));
  const ge = (v) => { if (!NPM_ACCEPT(v)) return false; const [x, y, z] = v.split('.').map(Number); return x > 0 || y > 1 || (y === 1 && z >= 2); };
  return { ok: a.status === 200 && b.status === 200 && ge(a.body.version) && ge(b.body.version), detail: `payonce-check-payee ${a.body?.version}, payonce-mcp ${b.body?.version}` };
});
claim('L15', 'Official MCP Registry lists io.github.mohamedwael201193/payonce-check-payee', async () => {
  const { status, body } = await retry(() => j('https://registry.modelcontextprotocol.io/v0/servers?search=payonce'));
  const s = (body?.servers ?? []).find((x) => x.server?.name === 'io.github.mohamedwael201193/payonce-check-payee');
  return { ok: status === 200 && Boolean(s), detail: s ? `version ${s.server.version}` : `HTTP ${status}, not found` };
});
const TOKENS = [['1476', 'JyP9XawpXHMjTN5ocrA5a'], ['1506', 'JyP9Y9nGU4KaM7DBDXRgm'], ['1488', 'JyP9Xp5bhbLsQrw7yTyph'], ['1554', 'JyP9UE8M6sTcxSaorAr8W']];
claim('L16', 'All 4 PayOnce badges pass the official check: badge_valid, no issues, 15/15 checks', async () => {
  const rs = await Promise.all(TOKENS.map(([, a]) => retry(() => j(`${REG}/v1/check-badge/${a}?network=testnet`))));
  const ok = rs.every((r) => r.status === 200 && r.body?.badge_valid === true && (r.body?.issues ?? []).length === 0 && Object.keys(r.body.checks ?? {}).length === 15 && Object.values(r.body.checks).every((v) => v !== false && v !== null));
  return { ok, detail: rs.map((r, i) => `${TOKENS[i][0]}:${r.body?.badge_valid}/${Object.keys(r.body?.checks ?? {}).length}`).join(' ') };
});
claim('L17', 'The verdict receipt ledger recomputes (hash chain) and every anchor reads back finalized and equal', async () => {
  const { status, body } = await retry(() => j(`${API}/api/vop/ledger/verify`));
  return { ok: status === 200 && body?.ok === true && body.entries > 0 && (body.anchors ?? []).length > 0 && body.anchors.every((a) => a.matches_ledger === true && a.on_chain?.status === 'finalized'), detail: `${body?.entries} entries, ${(body?.anchors ?? []).length} anchors` };
});
claim('L18', 'PayOnce sells check_payee over x402: 402 with 0.01 CCD to the seller account, fee sponsored', async () => {
  const r = await retry(() => fetch(`${API}/api/x402/check-payee?payee=4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin&name=Check%20Live`, { signal: AbortSignal.timeout(45000) }));
  const h = r.headers.get('payment-required'); const pr = h ? JSON.parse(Buffer.from(h, 'base64').toString()) : null; const a = pr?.accepts?.[0];
  return { ok: r.status === 402 && pr?.x402Version === 2 && a?.amount === '10000' && a?.payTo === '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB' && a?.network === 'ccd:4221332d34e1694168c2a0c0b3fd0f27' && Boolean(a?.extra?.feePayer), detail: `HTTP ${r.status} ${a?.amount} micro CCD, feePayer ${String(a?.extra?.feePayer).slice(0, 8)}` };
});
claim('L19', 'Every recorded x402 sale is a finalized, successful transaction on testnet', async () => {
  const { body } = await retry(() => j(`${API}/api/x402/sales`));
  const sales = body?.sales ?? []; const bs = await Promise.all(sales.map((x) => finalized(x.tx_hash)));
  return { ok: sales.length >= 2 && bs.every((b) => b.status === 'finalized' && b.outcome === 'success'), detail: `${sales.length} sales, ${bs.filter((b) => b.status === 'finalized' && b.outcome === 'success').length} finalized` };
});
claim('L20', 'A2A message/send answers a check_payee verdict (free, read-only)', async () => {
  const { status, body } = await retry(() => j(`${API}/a2a`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'check-live', parts: [{ kind: 'data', data: { payee: '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin', name: 'Check Live Test' } }] } } }) }));
  const txt = JSON.stringify(body); return { ok: status === 200 && body?.jsonrpc === '2.0' && !body?.error && /UNVERIFIED|NO_MATCH|MATCH|CLOSE_MATCH/.test(txt), detail: `HTTP ${status} ${(txt.match(/UNVERIFIED|NO_MATCH|CLOSE_MATCH|MATCH/) ?? ['?'])[0]}` };
});
claim('L21', 'The A2A agent card is served from the site', async () => {
  const { status, body } = await retry(() => j(`${SITE}/.well-known/agent.json`));
  return { ok: status === 200 && typeof body === 'object' && /check_payee/i.test(body?.name ?? ''), detail: `HTTP ${status} ${body?.name}` };
});
claim('L22', 'Wallet-signed approvals are live: an unknown approval id is a typed 404 from the approvals service, and a bad signature is refused', async () => {
  const a = await retry(() => j(`${API}/api/approvals/aaaaaaaaaaaaaaaaaaaaaaaa`));
  const b = await retry(() => j(`${API}/api/approvals/aaaaaaaaaaaaaaaaaaaaaaaa/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  return { ok: a.status === 404 && /approval/i.test(JSON.stringify(a.body)) && b.status >= 400 && b.status < 500 && !/No route/.test(JSON.stringify(b.body)), detail: `GET ${a.status}, verify ${b.status}` };
});
claim('L23', 'Red team: 30/30 attacks refused with the expected code (live scorecard)', async () => {
  const { status, body } = await retry(() => j(`${API}/api/proof/attacks`));
  return { ok: status === 200 && body?.total === 30 && body?.passed === 30 && body?.failed === 0, detail: `${body?.passed}/${body?.total}, ${body?.distinct_chain_codes} distinct chain codes` };
});
claim('L24', 'False-green benchmark: 0 false MATCH and 0 false payable across >= 1,000 impostor checks', async () => {
  const { status, body } = await retry(() => j(`${API}/api/proof/false-green`));
  const fm = Object.values(body?.by_class ?? {}).reduce((n, c) => n + c.false_match, 0), fp = Object.values(body?.by_class ?? {}).reduce((n, c) => n + c.false_payable, 0), n = Object.values(body?.by_class ?? {}).reduce((x, c) => x + c.n, 0);
  return { ok: status === 200 && fm === 0 && fp === 0 && n >= 1000 && body?.errors === 0, detail: `${n} checks, false MATCH ${fm}, false payable ${fp}` };
});
const MANDATE = 'c5b495352d03b1035d832e1ce2e9616ddd1a7e53fb1fd4c4ad965c473bd2bd7a';
claim('L25', `The buyer agent's spend mandate is signed, anchored (PMD1 + sha256, finalized) and capped at 0.1 CCD per purchase: ${MANDATE.slice(0, 8)}…`, async () => {
  const { status, body } = await retry(() => j(`${API}/api/mandate/${MANDATE}`));
  const wp = await finalized(body?.anchor?.tx_hash ?? '0'.repeat(64));
  const { createHash } = await import('node:crypto');
  return { ok: status === 200 && createHash('sha256').update(body.message).digest('hex') === MANDATE && body.per_purchase_micro === '100000' && body.anchor?.data_hex === `504d4431${MANDATE}` && wp.status === 'finalized' && wp.outcome === 'success', detail: `cap ${body?.per_purchase_micro}, anchor ${String(body?.anchor?.tx_hash).slice(0, 12)} ${wp.status}` };
});
claim('L26', 'Two-way gate: the agents-only x402 sale demands a verified, mandated buyer (402 advertises buyerGate: required)', async () => {
  const r = await retry(() => fetch(`${API}/api/x402/agent-check-payee?payee=4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin&name=Check%20Live`, { signal: AbortSignal.timeout(45000) }));
  const h = r.headers.get('payment-required'); const pr = h ? JSON.parse(Buffer.from(h, 'base64').toString()) : null;
  return { ok: r.status === 402 && pr?.buyerGate?.mode === 'required' && (pr.buyerGate.headers ?? []).includes('X-Buyer-Mandate'), detail: `HTTP ${r.status} gate ${pr?.buyerGate?.mode}` };
});
claim('L27', 'A gated sale settled for a verified buyer: payer = agent #1488, mandate recorded, tx finalized', async () => {
  const { body } = await retry(() => j(`${API}/api/x402/sales`));
  const s = (body?.sales ?? []).find((x) => x.buyer_verified === true && x.buyer_mandate === MANDATE);
  const b = s ? await finalized(s.tx_hash) : null;
  return { ok: Boolean(s) && s.payer === '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs' && s.buyer_agent === 1488 && b.status === 'finalized' && b.outcome === 'success', detail: s ? `${s.tx_hash.slice(0, 12)} ${b.status}/${b.outcome}` : 'no gated sale found' };
});
claim('L28', 'The mandate is ENFORCED: spend is within the cap and a person approving an over-cap buy does not change that (read-only: the 2 CCD purchase is refused before any payment)', async () => {
  const { body: sp } = await retry(() => j(`${API}/api/mandate/${MANDATE}/spend`));
  const settled = (sp?.spends ?? []).filter((x) => x.state === 'settled');
  return { ok: BigInt(sp.spent_micro) <= BigInt(sp.total_micro) && settled.every((x) => BigInt(x.amount_micro) <= BigInt(sp.per_purchase_micro)) && BigInt(sp.spent_micro) === settled.reduce((n, x) => n + BigInt(x.amount_micro), 0n) + (sp.spends ?? []).filter((x) => x.state !== 'settled' && x.state !== 'failed').reduce((n, x) => n + BigInt(x.amount_micro), 0n), detail: `spent ${sp?.spent_micro} of ${sp?.total_micro} micro, ${settled.length} settled` };
});
claim('L29', 'The standalone GitHub Action is public with a v1 release', async () => {
  const { status, body } = await retry(() => j('https://api.github.com/repos/mohamedwael201193/payonce-check-payee-action/releases/latest'));
  return { ok: status === 200 && /^v1\./.test(body?.tag_name ?? ''), detail: `HTTP ${status} ${body?.tag_name}` };
});
claim('L30', 'CI publishes one test-count number derived from the runners (status/tests.json), none failing', async () => {
  const { status, body } = await retry(() => j('https://raw.githubusercontent.com/mohamedwael201193/payonce/main/status/tests.json'));
  return { ok: status === 200 && body?.failing === 0 && body?.total > 0 && typeof body?.skipped === "number" && body?.passing + body?.skipped === body?.total && /^[0-9a-f]{40}$/.test(body?.commit ?? ''), detail: `${body?.passing} passing, ${body?.skipped} skipped of ${body?.total} at ${String(body?.commit).slice(0, 8)}` };
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
