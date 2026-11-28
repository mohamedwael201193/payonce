// G13 false-green benchmark: N adversarial check_payee calls through the PRODUCTION demo checker (vopDemo, live
// chain facts on the v3 demo book), counting how many impostors were told MATCH or payable. Seeded and reproducible:
//   PAYONCE_V3_INDEX=13173 node scripts/false-green.mjs [N=1000] [SEED=20261128]
// Impostor classes:
//   name   real payee account, invoice name is a lookalike (homoglyphs, 1-2 edits, swaps, extra/missing words, other
//          companies). Names whose normalised form equals the real name (case, spacing, word order) are the SAME
//          name, not impostors: counted separately as "equivalent", never as impostors.
//   addr   real name, wrong address: aliases of the real account (different address string the book never bound),
//          aliases of the lookalike pool, the demo impostors, other real accounts, random non-existent addresses.
//   both   random company names on wrong addresses.
// Result: kv proof/false_green:latest (served at GET /api/proof/false-green) and one line FALSE_GREEN {...}.
import { AccountAddress } from '@concordium/web-sdk';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { vopDemo } from '../src/vop-routes.mjs';
import { normalizeLegalName } from '../src/vop.mjs';
import { kvPut } from '../src/store.mjs';
import { aliasOf } from '../src/vop-attacks.mjs';

const N = Number(process.argv[2] ?? process.env.N ?? 1000);
const SEED = Number(process.argv[3] ?? process.env.SEED ?? 20261128);
const SELLER = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const NAME = 'PayOnce Labs';
const POOL = JSON.parse(readFileSync(new URL('./lookalike-pool.json', import.meta.url), 'utf8'));
const OTHERS = ['3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr', '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs', '3LgPU9K2WFg3ghFHXjm2r2Mizi2eqY71ENTWqHZL98h9ueFKMt', '4MDjZpfasyxR8sJDnyXewHU13QzxpNmhn3xUmeBxcui8mUS7Ns', '3GPTo1LQbwHcsxPLBmWAVAA4RF6FvbDkzbf7DvLkEKpxWMboHq'];

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(SEED);
const pick = (a) => a[Math.floor(R() * a.length)];
const HOMO = { a: ['а', 'ɑ', '@'], e: ['е', 'ё', '3'], o: ['о', '0', 'ο'], c: ['с', 'ϲ'], y: ['у', 'ү'], P: ['Р', 'Ρ'], O: ['О', '0', 'Ο'], L: ['Ⅼ', '1'], l: ['1', 'I', 'ӏ'], b: ['Ь', '6'], s: ['ѕ', '5', '$'], n: ['п', 'ŋ'] };
const ABC = 'abcdefghijklmnopqrstuvwxyz';
const COMPANIES = ['PayOne Labs', 'PayOnce Lab', 'PayOnce Labz', 'Pay Once Labs Holding', 'PayOnce Labs Ltd', 'PayOnce Labs ApS', 'PayOnce Systems', 'PayTwice Labs', 'PayOnce', 'Labs', 'PayOnce Labs Group', 'Paylonce Labs', 'Payonce Iabs', 'PayOnce Labs Denmark', 'P4yOnce Labs', 'Acme Corp', 'Concordium Labs', 'Stripe Payments Europe', 'Pay0nce Labs', 'PayOnce Labs Inc'];
function mutate(name) {
  const k = Math.floor(R() * 7); const ch = [...name];
  if (k === 0) { const idx = ch.map((c, i) => (HOMO[c] ? i : -1)).filter((i) => i >= 0); const n = 1 + Math.floor(R() * 2); for (let j = 0; j < n && idx.length; j++) { const i = idx.splice(Math.floor(R() * idx.length), 1)[0]; ch[i] = pick(HOMO[ch[i]]); } return ch.join(''); }
  if (k === 1) { const i = Math.floor(R() * ch.length); ch.splice(i, 1); return ch.join(''); }
  if (k === 2) { const i = Math.floor(R() * ch.length); ch.splice(i, 0, pick([...ABC])); return ch.join(''); }
  if (k === 3) { const i = Math.floor(R() * (ch.length - 1)); [ch[i], ch[i + 1]] = [ch[i + 1], ch[i]]; return ch.join(''); }
  if (k === 4) { const i = Math.floor(R() * ch.length); ch[i] = pick([...ABC]); return ch.join(''); }
  if (k === 5) return `${name} ${pick(['Ltd', 'Holding', 'Group', 'Services', 'ApS', 'Inc', 'Payments', 'EU'])}`;
  return pick(COMPANIES);
}
function randomAddress() { const b = Buffer.alloc(32); for (let i = 0; i < 32; i++) b[i] = Math.floor(R() * 256); return AccountAddress.fromBuffer(b).address; }
function wrongAddress() {
  const k = Math.floor(R() * 5);
  if (k === 0) return { address: aliasOf(SELLER, 1 + Math.floor(R() * 0xfffffe)), kind: 'alias_of_real_payee' };
  if (k === 1) { const e = pick(POOL.pool); return { address: R() < 0.5 ? e.alias : aliasOf(e.canonical, Math.floor(R() * 0xffffff)), kind: 'lookalike_pool' }; }
  if (k === 2) return { address: pick(OTHERS), kind: 'other_real_account' };
  return { address: randomAddress(), kind: 'random_address' };
}

const realNorm = normalizeLegalName(NAME);
const cases = [];
for (let i = 0; i < N; i++) {
  const r = R();
  if (r < 0.45) { const n = mutate(NAME); cases.push({ i, cls: 'name', payee: SELLER, name: n, addr_kind: 'real_payee' }); }
  else if (r < 0.8) { const w = wrongAddress(); cases.push({ i, cls: 'addr', payee: w.address, name: NAME, addr_kind: w.kind }); }
  else { const w = wrongAddress(); cases.push({ i, cls: 'both', payee: w.address, name: mutate(pick(COMPANIES)), addr_kind: w.kind }); }
}
for (const c of cases) c.equivalent = c.payee === SELLER && normalizeLegalName(c.name) === realNorm;

const t0 = Date.now();
const results = new Array(cases.length);
let next = 0;
async function worker() {
  for (;;) {
    const j = next++; if (j >= cases.length) return;
    const c = cases[j];
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await vopDemo.check({ seller: SELLER, payee: c.payee, legal_name: c.name });
        results[j] = { ...c, verdict: r.verdict, payable: !!r.payable, evidence_hash: r.evidence_hash ?? null };
        break;
      } catch (e) {
        if (attempt < 12 && /429|UNAVAILABLE|unavailable|timeout|ECONNRESET|did not answer/i.test(String(e?.message ?? e))) { await new Promise((ok) => setTimeout(ok, Math.min(30_000, 1500 * 2 ** Math.min(attempt, 5)))); continue; }
        results[j] = { ...c, verdict: 'ERROR', payable: false, error: String(e?.message ?? e).slice(0, 120) };
        break;
      }
    }
  }
}
await Promise.all(Array.from({ length: Number(process.env.CONCURRENCY ?? 4) }, worker));

const imp = results.filter((r) => !r.equivalent);
const by = (f) => imp.filter(f).length;
const summary = {
  generated_at: new Date().toISOString(), took_ms: Date.now() - t0, seed: SEED, n: results.length, network: 'Concordium testnet', book: '<13173,0>',
  checker: 'production vopDemo.check (api/src/vop-service.mjs + vop.mjs decideVop), live chain facts',
  impostors: imp.length, equivalent_same_name: results.length - imp.length,
  false_match: by((r) => r.verdict === 'MATCH'), false_payable: by((r) => r.payable), errors: by((r) => r.verdict === 'ERROR'),
  verdicts: Object.fromEntries(['MATCH', 'CLOSE_MATCH', 'NO_MATCH', 'UNVERIFIED', 'ERROR'].map((v) => [v, by((r) => r.verdict === v)])),
  by_class: Object.fromEntries(['name', 'addr', 'both'].map((k) => [k, { n: by((r) => r.cls === k), false_match: by((r) => r.cls === k && r.verdict === 'MATCH'), false_payable: by((r) => r.cls === k && r.payable) }])),
  equivalent_verdicts: Object.fromEntries(['MATCH', 'CLOSE_MATCH', 'NO_MATCH', 'UNVERIFIED'].map((v) => [v, results.filter((r) => r.equivalent && r.verdict === v).length])),
  cases_sha256: createHash('sha256').update(JSON.stringify(results.map((r) => [r.i, r.payee, r.name, r.verdict, r.payable]))).digest('hex'),
};
summary.headline = `${summary.false_match} false MATCH and ${summary.false_payable} false payable out of ${summary.impostors} impostor checks (seed ${SEED}${summary.errors ? `, ${summary.errors} errors` : ''})`;
await kvPut('proof', 'false_green:latest', { ...summary, cases: results.map((r) => ({ i: r.i, cls: r.cls, addr_kind: r.addr_kind, payee: r.payee, name: r.name, equivalent: r.equivalent, verdict: r.verdict, payable: r.payable, ...(r.error ? { error: r.error } : {}) })) });
console.log(`FALSE_GREEN ${JSON.stringify(summary)}`);
process.exit(0);
