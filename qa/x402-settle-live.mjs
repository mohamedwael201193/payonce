// qa/x402-settle-live.mjs — ONE real x402 settle on Concordium TESTNET through the HOSTED facilitator
// (https://x402-facilitator.testnet.concordium.com), for a PayOnce payable.
//
//   node qa/x402-settle-live.mjs [--out backend/test/x402-hosted-settle-2026-11-26.json]
//
// What happens (all real, testnet, dust = 0.01 EUDemo):
//   1. the owner (seller 1) registers a fresh lab payable (EUDemo 0.01, named payer = the demo payer);
//   2. the demo payer reserves it on the registry (reserve_plt);
//   3. the demo payer signs a SPONSORED token transfer (memo payable:<seller>:<id>) whose fee payer is
//      the hosted facilitator's address (read live from GET /supported);
//   4. hosted POST /verify, then PayOnce's binding checks (amount, payee, status, canonical memo), then hosted
//      POST /settle; the settle transaction is READ BACK from the chain and its contents matched
//      (a facilitator "success" is never trusted on its own);
//   5. the demo payer confirms the transfer hash on the registry (confirm_plt) -> Paid;
//   6. the independent keyless verifier (api/src/verify-payable-v2.mjs, no key) re-checks the whole payment.
// The facilitator API key and the wallet keys are read in-process from an .env file (PAYONCE_E2E_ENV or the
// first .env found above this repo), never printed, written or logged; every error is redacted.
import { readFileSync, existsSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('--out', join(REPO, 'backend', 'test', 'x402-hosted-settle-2026-11-26.json'));

function parseDotenv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const SECRETS = [];
function loadEnv() {
  for (const p of [process.env.PAYONCE_E2E_ENV, join(REPO, '.env'), join(REPO, '..', '.env'), join(REPO, '..', '..', '.env')].filter(Boolean)) {
    if (!existsSync(p)) continue;
    const e = parseDotenv(readFileSync(p, 'utf8'));
    const priv = e.CONCORDIUM_WALLET_PRIVATE_KEY ?? e.private_key;
    const seed = e.CONCORDIUM_WALLET_SEED_PHRASE ?? e.seed_phares;
    const fac = e.X402_FACILITATOR_API_KEY ?? e.facilitator_api_key;
    if (priv && seed && fac) {
      process.env.CONCORDIUM_WALLET_PRIVATE_KEY = priv.trim();
      process.env.CONCORDIUM_WALLET_SEED_PHRASE = seed.trim();
      process.env.X402_FACILITATOR_API_KEY = fac.trim();
      SECRETS.push(priv.trim(), seed.trim(), fac.trim(), ...seed.trim().split(/\s+/));
      return true;
    }
  }
  return false;
}
function redact(text) {
  let s = String(text ?? '');
  for (const sec of SECRETS) if (sec && sec.length >= 6) s = s.split(sec).join('[redacted]');
  s = s.replace(/\b(?:[a-z]{3,12}\s+){11,}[a-z]{3,12}\b/gi, '[redacted-words]');
  s = s.replace(/\b[0-9a-f]{64}\b/gi, '[hex64]');
  return s.slice(0, 500);
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const imp = (p) => import(pathToFileURL(join(REPO, p)).href);
const log = (...a) => console.log(...a);

async function main() {
  if (!loadEnv()) throw new Error('no .env with the wallet keys and facilitator_api_key found (set PAYONCE_E2E_ENV)');
  const { createHostedFacilitator, HOSTED_TESTNET_CAIP2 } = await imp('backend/src/facilitator/hosted.mjs');
  const { settlePayableHostedFirst, verifyPayableHostedFirst, confirmSettleTxOnChain } = await imp('backend/src/facilitator/hosted-payonce.mjs');
  const { requirementsForHostedPayable } = await imp('backend/src/facilitator/hosted.mjs');
  const { buildMemoPltPayload } = await imp('backend/src/facilitator/client.mjs');
  const chain = await imp('api/src/chain-v2.mjs');
  const conf = await imp('api/src/config.mjs');
  const jobs = await imp('api/src/jobs.mjs');
  const { backend } = await imp('api/src/backend.mjs');
  const { v2enc } = await backend();
  const sig = await chain.signers();
  const c = await chain.grpc();
  const S1 = conf.OWNER_ADDRESS;
  const hosted = createHostedFacilitator({ apiKey: process.env.X402_FACILITATOR_API_KEY });
  const ev = { generated_at: new Date().toISOString(), network: 'testnet', facilitator: 'https://x402-facilitator.testnet.concordium.com', asset: 'EUDemo', amount_base_units: '10000', amount_display: '0.01 EUDemo', steps: {} };

  // 0. facilitator reachable + the sponsor address
  const health = await hosted.health();
  const supported = await hosted.supported();
  const feePayer = await hosted.feePayer();
  ev.steps.health = health;
  ev.steps.supported = { kinds: supported.kinds, signers: supported.signers };
  log(`hosted /health ${JSON.stringify(health)}; feePayer ${feePayer}`);

  // 1. register
  const id = 90000 + (Math.floor(Date.now() / 1000) % 9000);
  const dueMs = Date.now() + 6 * 3_600_000;
  const docText = ['PAYONCE LAB INVOICE (testnet, not a real invoice)', `Invoice: ${id}`, `Seller: ${S1}`, `Payee: ${conf.PAYEE_EUDEMO}`, 'Asset: EUDemo', 'Amount: 10000', `Due: ${new Date(dueMs).toISOString()}`, 'x402 settle proof (hosted facilitator)', ''].join('\n');
  const docHash = sha256(Buffer.from(docText));
  const reg = await chain.sendUpdate(c, { from: sig.owner, receiveName: 'register_payable', maxEnergy: 6000n, parameterHex: v2enc.encodeV2RegisterPayable({ id, payee: conf.PAYEE_EUDEMO, amount: '10000', asset: 'EUDemo', dueMs, docHashHex: docHash, token: conf.OWNER_TOKEN, expected: conf.PAYER_ADDRESS, legal: null }) });
  const regSt = await chain.waitFinalized(c, reg.txHash);
  if (jobs.rejectOf(regSt)) throw new Error(`register rejected: ${JSON.stringify(jobs.rejectInfo(jobs.rejectOf(regSt).rejectReason))}`);
  ev.payable = { seller: S1, id, payee: conf.PAYEE_EUDEMO, payer: conf.PAYER_ADDRESS, doc_sha256: docHash, register_tx: reg.txHash };
  log(`1 registered payable ${id}: ${reg.txHash}`);

  // 2. reserve (demo payer)
  const rs = await chain.sendUpdate(c, { from: sig.sellerB, receiveName: 'reserve_plt', maxEnergy: 6000n, parameterHex: v2enc.encodeV2PayableKey({ seller: S1, id }) });
  const rsSt = await chain.waitFinalized(c, rs.txHash);
  if (jobs.rejectOf(rsSt)) throw new Error('reserve rejected');
  let view = await chain.getPayable(c, S1, id);
  if (view.status !== 'Reserved') throw new Error(`payable is ${view.status} after reserve`);
  ev.payable.reserve_tx = rs.txHash;
  log(`2 reserved until ${view.record.expires}: ${rs.txHash}`);

  // 3. payload: sponsored EUDemo transfer, memo payable:<seller>:<id>, header expiry bound to the reservation
  const memo = `payable:${S1}:${id}`;
  // header expiry: inside the reservation (minus the co-signer margin) AND inside the hosted facilitator's 300 s limit
  const expirySeconds = Math.min(Math.floor((Number(view.record.expiresMs) - 60_000) / 1000), Math.floor(Date.now() / 1000) + 240);
  const payload = await buildMemoPltPayload({ grpc: c, sender: sig.sellerB, sponsorAddress: feePayer, recipient: view.payee, amount: '10000', tokenId: 'EUDemo', memo, expirySeconds });
  const requirements = requirementsForHostedPayable(view, { feePayer });
  payload.accepted = requirements; // the hosted schema wants the full accepted requirements, as in the live probes
  // The binding module keys payables by the string after `payable:` in the memo, so the v2 key
  // "<seller>:<id>" makes the canonical v2 memo check exact; loadPayable splits it back.
  const key = `${S1}:${id}`;
  const loadPayable = async (k) => { const [s, i] = String(k).split(':'); return chain.getPayable(c, s, Number(i)); };

  // 4a. hosted verify (captured separately so the report holds both responses)
  const verified = await verifyPayableHostedFirst({ hosted, selfHosted: null, loadPayable, payload, requirements, payableId: key, expectedStatus: 'Reserved', allowFallback: false });
  ev.steps.verify = { isValid: verified.isValid, payer: verified.payer, invalidReason: verified.invalidReason ?? null, facilitator: verified.facilitator, binding_checks: verified.payonce?.checks };
  log(`4a hosted /verify + PayOnce binding: isValid=${verified.isValid} payer=${verified.payer} ${verified.invalidReason ?? ''}`);
  if (!verified.isValid) throw new Error(`hosted verify refused: ${verified.invalidReason} ${verified.invalidMessage ?? ''}`);

  // 4b. settle (re-verifies, settles, reads the transaction back and matches its contents)
  const settled = await settlePayableHostedFirst({ hosted, grpc: c, loadPayable, payload, requirements, payableId: key, expectedStatus: 'Reserved' });
  ev.steps.settle = { success: settled.success, network: settled.network, transaction: settled.transaction, payer: settled.payer, errorReason: settled.errorReason ?? null, errorMessage: settled.errorMessage ?? null, readBack: settled.settleConfirmation ?? null, facilitator: settled.facilitator };
  log(`4b hosted /settle: success=${settled.success} tx=${settled.transaction} ${settled.errorReason ?? ''} readBack=${JSON.stringify(settled.settleConfirmation ?? null)}`);
  // The facilitator may answer success:false with finalization_failed (its own read lagged) while the
  // transaction it submitted does land. Never trust either side blindly: read the transaction back from the
  // chain ourselves, wait for it, and match its contents (sender, recipient, amount, token, memo).
  const claimed = /^[0-9a-f]{64}$/.test(settled.transaction ?? '') ? settled.transaction : (settled.claimedTransaction ?? '');
  if (!/^[0-9a-f]{64}$/.test(claimed)) throw new Error(`hosted settle returned no transaction: ${settled.errorReason} ${settled.errorMessage ?? ''}`);
  let readBack = settled.settleConfirmation ? { confirmed: true, ...settled.settleConfirmation } : null;
  for (let i = 0; !readBack?.confirmed && i < 8; i += 1) {
    readBack = await confirmSettleTxOnChain(claimed, { grpc: c, expected: { sender: sig.sellerB.address, amount: '10000', recipient: view.payee, asset: 'EUDemo', payableId: key } });
    if (readBack.confirmed || readBack.contentMismatch) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  ev.steps.settle_readback = readBack;
  log(`4c read-back of ${claimed} from the chain: ${JSON.stringify(readBack)}`);
  if (!readBack?.confirmed) throw new Error(`settle transaction not confirmed on chain: ${readBack?.reason}`);
  settled.transaction = claimed;
  const stx = await chain.getTx(c, settled.transaction);
  ev.steps.settle_tx_on_chain = { status: stx.status, sender: stx.summary?.sender, type: stx.summary?.transactionType, events: (stx.summary?.events ?? []).map((e) => ({ tag: e.tag, tokenId: e.tokenId, from: e.from?.address ?? e.from, to: e.to?.address ?? e.to, amount: String(e.amount?.value ?? e.amount ?? '') })), cost_microccd: String(stx.summary?.cost ?? '') };

  // 5. confirm (demo payer)
  const cf = await chain.sendUpdate(c, { from: sig.sellerB, receiveName: 'confirm_plt', maxEnergy: 6000n, parameterHex: v2enc.encodeV2Confirm({ seller: S1, id, txHashHex: settled.transaction }) });
  const cfSt = await chain.waitFinalized(c, cf.txHash);
  if (jobs.rejectOf(cfSt)) throw new Error('confirm rejected');
  view = await chain.getPayable(c, S1, id);
  ev.payable.confirm_tx = cf.txHash;
  ev.payable.status_after = view.status;
  log(`5 confirmed ${cf.txHash}; payable status ${view.status}`);
  if (view.status !== 'Paid') throw new Error(`payable is ${view.status} after confirm`);

  // 6. independent keyless verifier
  const dir = mkdtempSync(join(tmpdir(), 'payonce-x402-'));
  const docPath = join(dir, `invoice-${id}.txt`);
  writeFileSync(docPath, docText);
  let verifier;
  try {
    const out = execFileSync(process.execPath, [join(REPO, 'api', 'src', 'verify-payable-v2.mjs'), String(id), settled.transaction, '--doc', docPath, '--rail', 'eudemo', '--reserve', rs.txHash, '--confirm', cf.txHash], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PAYONCE_DATA_DIR: dir }, encoding: 'utf8', timeout: 150_000 });
    verifier = { ok: /ALL CHECKS PASS/.test(out), summary: out.trim().split('\n').pop(), lines: out.trim().split('\n') };
  } catch (e) { verifier = { ok: false, summary: redact(e.stdout ?? e.message) }; }
  ev.steps.keyless_verifier = verifier;
  log(`6 keyless verifier: ${verifier.summary}`);
  ev.ok = verifier.ok && readBack.confirmed === true && view.status === 'Paid';
  ev.facilitator_settle_response_success = settled.success;
  ev.explorer = { settle_tx: `https://ccdexplorer.io/testnet/transaction/${settled.transaction}`, confirm_tx: `https://ccdexplorer.io/testnet/transaction/${cf.txHash}` };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(ev, null, 2));
  log(`evidence written to ${OUT}; ok=${ev.ok}`);
  process.exit(ev.ok ? 0 : 1);
}
main().catch((e) => { console.error('x402 settle aborted:', redact(e?.message ?? e)); process.exit(2); });
