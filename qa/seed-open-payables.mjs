// qa/seed-open-payables.mjs — register a set of OPEN (Unpaid, not past due) lab payables on the testnet
// registry so a judge can pay one on the live site: both sellers (1476, 1506), both rails (CCD, EUDemo),
// dust amounts, due 2026-12-12 (after the 9 Dec 2026 submission date).
//
//   node qa/seed-open-payables.mjs [--per 3] [--due 2026-12-12] [--out qa/out/seed-open-payables.json]
//
// Each payable is the exact lab invoice the API regenerates and serves (generateLabDocument), so its document
// hash matches the on-chain hash and GET /api/payables/:id/document works with no stored copy. Seller 1's ids
// continue its contiguous fresh range, seller 2's start at 5000, so the API's frontier discovery lists them.
// Keys are read in-process from an .env (PAYONCE_E2E_ENV or the first .env above this repo), never printed.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PER = Number(opt('--per', 3));
const DUE = Date.parse(`${opt('--due', '2026-12-12')}T12:00:00Z`);
const OUT = opt('--out', join(HERE, 'out', 'seed-open-payables.json'));
if (!(DUE > Date.parse('2026-12-09T23:59:59Z'))) throw new Error('--due must be after 9 Dec 2026');

function parseDotenv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const m = raw.replace(/\r$/, '').match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !raw.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
function loadKeys() {
  for (const p of [process.env.PAYONCE_E2E_ENV, join(REPO, '.env'), join(REPO, '..', '.env'), join(REPO, '..', '..', '.env')].filter(Boolean)) {
    if (!existsSync(p)) continue;
    const e = parseDotenv(readFileSync(p, 'utf8'));
    const priv = e.CONCORDIUM_WALLET_PRIVATE_KEY ?? e.private_key, seed = e.CONCORDIUM_WALLET_SEED_PHRASE ?? e.seed_phares;
    if (priv && seed) { process.env.CONCORDIUM_WALLET_PRIVATE_KEY = priv.trim(); process.env.CONCORDIUM_WALLET_SEED_PHRASE = seed.trim(); return; }
  }
  throw new Error('no .env with the wallet keys found (set PAYONCE_E2E_ENV)');
}
loadKeys();
const imp = (p) => import(pathToFileURL(join(REPO, p)).href);
const chain = await imp('api/src/chain-v2.mjs');
const conf = await imp('api/src/config.mjs');
const docs = await imp('api/src/docs.mjs');
const jobs = await imp('api/src/jobs.mjs');
const { backend } = await imp('api/src/backend.mjs');
const { v2enc } = await backend();
const sig = await chain.signers();
const c = await chain.grpc();

async function nextFree(seller, from) {
  let id = from;
  while (await chain.getPayableOrNull(c, seller, id)) id += 1;
  return id;
}

const plan = [
  { key: 'seller1', seller: conf.OWNER_ADDRESS, signer: sig.owner, token: conf.OWNER_TOKEN, start: conf.FRESH_ID_START },
  { key: 'seller2', seller: conf.SELLER2_ADDRESS, signer: sig.seller2, token: conf.SELLER2_TOKEN, start: conf.SELLER2_FRESH_ID_START },
];
const result = [];
for (const p of plan) {
  let id = await nextFree(p.seller, p.start);
  for (const rail of ['ccd', 'eudemo']) {
    for (let n = 0; n < PER; n += 1) {
      const asset = rail === 'ccd' ? 'CCD' : 'EUDemo';
      const amount = rail === 'ccd' ? 100000n : 10000n; // 0.1 CCD / 0.01 EUDemo
      const payee = p.key === 'seller2' ? p.seller : rail === 'ccd' ? conf.PAYEE_CCD : conf.PAYEE_EUDEMO;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        id = await nextFree(p.seller, id);
        const text = docs.generateLabDocument({ id, asset, amount: amount.toString(), payee, seller: p.seller, due: DUE });
        const docHash = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
        const sent = await chain.sendUpdate(c, { from: p.signer, receiveName: 'register_payable', maxEnergy: 6000n, parameterHex: v2enc.encodeV2RegisterPayable({ id, payee, amount: amount.toString(), asset, dueMs: DUE, docHashHex: docHash, token: p.token, expected: conf.PAYER_ADDRESS, legal: null }) });
        const st = await chain.waitFinalized(c, sent.txHash);
        const rr = jobs.rejectOf(st);
        if (rr && jobs.rejectInfo(rr.rejectReason).code === -2) { id += 1; continue; } // someone else took the id
        if (rr) throw new Error(`register rejected: ${JSON.stringify(jobs.rejectInfo(rr.rejectReason))}`);
        const view = await chain.getPayable(c, p.seller, id);
        const row = { seller: p.key, seller_address: p.seller, payable_id: id, rail, amount: amount.toString(), status: view.status, due: new Date(DUE).toISOString(), doc_sha256: docHash, register_tx: sent.txHash };
        result.push(row);
        console.log(`${p.key} ${rail} payable ${id} ${view.status} due ${row.due} tx ${sent.txHash}`);
        id += 1;
        break;
      }
    }
  }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), registry: `<${conf.REGISTRY.index},${conf.REGISTRY.subindex}>`, payables: result }, null, 2));
console.log(`${result.length} open payables registered; written to ${OUT}`);
