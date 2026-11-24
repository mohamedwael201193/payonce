// matrix-v2.mjs — LIVE matrix for payable_registry_v2 <13150,0> on TESTNET.
// Single-signer matrix (deployer only): the second signer (account B's key)
// is NOT available in this workspace — B's address is sha256(credId) and the
// credId comes from the identity object, so the key cannot be derived from
// the seed. Consequence, recorded honestly: a successful pay_ccd /
// reserve_plt / confirm_plt needs a second signer and is proven by the
// 80/80 Chain-engine unit tests instead; this script proves everything a
// single signer CAN prove live: registration (success + rejects), the
// cross-call to the REAL CIS-8004 registry, vendor-row lifecycle,
// owner controls, void lifecycle, and every reject code reachable before
// the payer!=seller guard.
// Every case records its FULL tx hash. Usage: node matrix-v2.mjs
// Writes: matrix-v2-result.json
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { AccountAddress, Transaction, TransactionExpiry, buildBasicAccountSigner, ContractAddress, ReceiveName, Parameter, CcdAmount, Energy } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
import fs from 'node:fs';
import crypto from 'node:crypto';

const ENV_PATH = '/home/hatch/workspace/user/files/env-db535f55.txt';
const CONTRACT = ContractAddress.create(13150n, 0n);
const EXPECTED_ADDRESS = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const ACCOUNT_B = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';
const CONTRACT_NAME = 'payable_registry_v2';

const env = {};
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const t = line.replace(/\r$/, '').trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}
const address = (env.address_wallet || '').trim();
const privKey = (env.private_key || '').replace(/^0x/, '').trim();
if (address !== EXPECTED_ADDRESS || !/^[0-9a-fA-F]{64}$/.test(privKey)) {
  console.log('env address/key check failed — aborting (nothing printed).');
  process.exit(1);
}

const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const addr = AccountAddress.fromBase58(address);
const buyerB = AccountAddress.fromBase58(ACCOUNT_B);
const signer = buildBasicAccountSigner(privKey);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');
const results = [];

// --- encoders (concordium-std Serial, little-endian) ---
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const ab = (a) => Buffer.from(a.decodedAddress);
const optAddr = (a) => (a ? Buffer.concat([Buffer.from([1]), ab(a)]) : Buffer.from([0]));
const optHash = (h) => (h ? Buffer.concat([Buffer.from([1]), Buffer.from(h, 'hex')]) : Buffer.from([0]));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const assetCcd = () => Buffer.from([0]);
const assetPlt = (name) => Buffer.concat([Buffer.from([1]), u32le(Buffer.byteLength(name)), Buffer.from(name)]);
const registerParam = ({ id, payee, amount, asset, dueMs, docHash, token, expected, legal }) =>
  Buffer.concat([u64le(id), ab(payee), u64le(amount), asset, u64le(dueMs), Buffer.from(docHash, 'hex'), u64le(token), optAddr(expected), optHash(legal)]);
const keyParam = (seller, id) => Buffer.concat([ab(seller), u64le(id)]);
const voidParam = (id) => u64le(id);
const strictParam = (v) => Buffer.from([v ? 1 : 0]);
const approveParam = ({ seller, tier, legal, perCap, periodCap, periodSecs }) =>
  Buffer.concat([ab(seller), Buffer.from([tier]), optHash(legal), u64le(perCap), u64le(periodCap), u64le(periodSecs)]);
const vendorParam = (buyer, seller) => Buffer.concat([ab(buyer), ab(seller)]);

function rejectReason(status) {
  const sj = JSON.stringify(status, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  try {
    const s = JSON.parse(sj);
    const rr = s.outcome?.summary?.rejectReason;
    if (rr) return rr;
    // Fallback: scan for a numeric rejectReason in the summary JSON.
    const m = sj.match(/"rejectReason":\s*(-?\d+)/);
    if (m) return { rejectReason: Number(m[1]) };
  } catch { /* fall through */ }
  return null;
}

async function send(label, receiveName, paramBuf, amountMicro, expect) {
  const info = await client.getAccountInfo(addr);
  const tx = Transaction.updateContract({
    amount: CcdAmount.fromMicroCcd(BigInt(amountMicro)),
    address: CONTRACT,
    receiveName: ReceiveName.fromString(`${CONTRACT_NAME}.${receiveName}`),
    message: Parameter.fromBuffer(paramBuf),
  }, Energy.create(300000n)).addMetadata({
    sender: addr,
    nonce: info.accountNonce,
    expiry: TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
  });
  const fin = await Transaction.signAndFinalize(tx.build(), signer);
  const h = await client.sendTransaction(fin);
  const hashHex = hex(h.buffer);
  let status = null;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    status = await client.getBlockItemStatus(h);
    if (status.status === 'finalized') break;
  }
  const sj = JSON.stringify(status, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const summary = JSON.parse(sj).outcome?.summary ?? {};
  const rr = rejectReason(status);
  const reason = rr?.rejectReason ?? null;
  const outcome = summary.transactionType === 'update' && rr ? `REJECT ${reason}` : summary.transactionType === 'update' ? 'SUCCESS' : JSON.stringify(summary).slice(0, 200);
  const pass = expect === null ? reason === null : reason === expect;
  console.log(`[${label}] ${hashHex.slice(0, 16)}… ${outcome} | expected ${expect === null ? 'SUCCESS' : 'REJECT ' + expect} | ${pass ? 'PASS' : 'FAIL'}`);
  results.push({ label, hash: hashHex, outcome, expected: expect, pass, costMicroCcd: summary.cost ?? null, energy: summary.energyCost?.value ?? null, rejectReason: rr, summary: sj.slice(0, 1200) });
  return { hashHex, status, pass };
}

async function view(label, method, paramBuf) {
  const res = await client.invokeContract({
    contract: CONTRACT,
    method: ReceiveName.fromString(`${CONTRACT_NAME}.${method}`),
    parameter: Parameter.fromBuffer(paramBuf),
  });
  // returnValue is a ReturnValue wrapper; .buffer is the raw bytes (probe.mjs).
  const raw = Buffer.from(res.returnValue?.buffer ?? res.returnValue ?? []);
  console.log(`[view ${label}] ${raw.length} bytes: ${raw.toString('hex').slice(0, 160)}${raw.length > 80 ? '…' : ''}`);
  return raw;
}

// --- view parsers ---
function parseConfig(b) {
  return { cis8004: `<${b.readBigUInt64LE(0)},${b.readBigUInt64LE(8)}>`, reservation_secs: Number(b.readBigUInt64LE(16)) };
}
function parsePayable(b) {
  if (b[0] === 0) return null;
  let p = 1;
  const seller = b.subarray(p, p + 32).toString('hex'); p += 32;
  const id = Number(b.readBigUInt64LE(p)); p += 8;
  const payee = b.subarray(p, p + 32).toString('hex'); p += 32;
  const amount = Number(b.readBigUInt64LE(p)); p += 8;
  const assetTag = b[p++];
  let asset = 'Ccd';
  if (assetTag === 1) { const len = b.readUInt32LE(p); p += 4; asset = 'Plt(' + b.subarray(p, p + len).toString() + ')'; p += len; }
  const due = Number(b.readBigUInt64LE(p)); p += 8;
  const docHash = b.subarray(p, p + 32).toString('hex'); p += 32;
  const token = Number(b.readBigUInt64LE(p)); p += 8;
  const expFlag = b[p++];
  const expected = expFlag ? b.subarray(p, p + 32).toString('hex') : null; if (expFlag) p += 32;
  const legFlag = b[p++];
  const legal = legFlag ? b.subarray(p, p + 32).toString('hex') : null; if (legFlag) p += 32;
  const stTag = b[p++];
  let status = 'Unpaid';
  if (stTag === 1) { const payer = b.subarray(p, p + 32).toString('hex'); p += 32; const at = Number(b.readBigUInt64LE(p)); p += 8; const ex = Number(b.readBigUInt64LE(p)); p += 8; status = `Reserved payer=${payer.slice(0, 8)}… at=${at} exp=${ex}`; }
  else if (stTag === 2) { const payer = b.subarray(p, p + 32).toString('hex'); p += 32; const reFlag = b[p++]; let re = null; if (reFlag) { re = Number(b.readBigUInt64LE(p)); p += 8; } const at = Number(b.readBigUInt64LE(p)); p += 8; const txFlag = b[p++]; let tx = null; if (txFlag) { tx = b.subarray(p, p + 32).toString('hex'); p += 32; } status = `Paid payer=${payer.slice(0, 8)}… at=${at} tx=${tx ? tx.slice(0, 12) + '…' : 'none'}`; }
  else if (stTag === 3) { const at = Number(b.readBigUInt64LE(p)); p += 8; status = `Voided at=${at}`; }
  return { seller: seller.slice(0, 12) + '…', id, payee: payee.slice(0, 12) + '…', amount, asset, due, docHash: docHash.slice(0, 12) + '…', token, expected: expected ? expected.slice(0, 12) + '…' : null, legal: legal ? legal.slice(0, 12) + '…' : null, status };
}
function parseVendor(b) {
  if (b[0] === 0) return null;
  let p = 1;
  const tier = b[p++];
  const legFlag = b[p++];
  const legal = legFlag ? b.subarray(p, p + 32).toString('hex') : null; if (legFlag) p += 32;
  const per = Number(b.readBigUInt64LE(p)); p += 8;
  const period = Number(b.readBigUInt64LE(p)); p += 8;
  const secs = Number(b.readBigUInt64LE(p)); p += 8;
  return { tier, legal: legal ? legal.slice(0, 12) + '…' : null, per_payable_cap: per, period_cap: period, period_secs: secs };
}

// --- run ---
const info0 = await client.getAccountInfo(addr);
const bInfo0 = await client.getAccountInfo(buyerB);
console.log('deployer CCD before:', Number(info0.accountAmount.microCcdAmount) / 1e6, '| nonce:', String(info0.accountNonce?.nonce ?? info0.accountNonce));
console.log('account B CCD before:', Number(bInfo0.accountAmount.microCcdAmount) / 1e6);
const now = Date.now();
const DUE7D = now + 7 * 24 * 3600 * 1000;
const DOC = (n) => sha(`payonce-live-matrix-${n}`);

// V0: config view
const cfg = parseConfig(await view('get_config', 'get_config', Buffer.alloc(0)));
console.log('config:', JSON.stringify(cfg));
results.push({ label: 'view get_config', config: cfg, pass: cfg.cis8004 === '<12802,0>' && cfg.reservation_secs === 3600 });

// V1: payable 1 absent before registration
const pre = parsePayable(await view('get_payable(1) pre', 'get_payable', keyParam(addr, 1)));
console.log('payable 1 pre-register:', pre);
results.push({ label: 'view get_payable(1) pre', value: pre, pass: pre === null });

// 1. register P1 (CCD 10, token 1476) -> SUCCESS
await send('register P1 CCD 10 (token 1476)', 'register_payable', registerParam({ id: 1, payee: buyerB, amount: 10_000_000, asset: assetCcd(), dueMs: DUE7D, docHash: DOC(1), token: 1476, expected: null, legal: null }), 0, null);
// 2. view P1
console.log('payable 1:', JSON.stringify(parsePayable(await view('get_payable(1)', 'get_payable', keyParam(addr, 1)))));
// 3. register P1 again -> -2 Duplicate
await send('register P1 again', 'register_payable', registerParam({ id: 1, payee: buyerB, amount: 10_000_000, asset: assetCcd(), dueMs: DUE7D, docHash: DOC(1), token: 1476, expected: null, legal: null }), 0, -2);
// 4. register id=11 token 1261 (Active, other owner) -> -10 AgentOwnerMismatch
await send('register id=11 token 1261 (other owner)', 'register_payable', registerParam({ id: 11, payee: buyerB, amount: 1_000_000, asset: assetCcd(), dueMs: DUE7D, docHash: DOC(11), token: 1261, expected: null, legal: null }), 0, -10);
// 5. register id=12 token 999999 (nonexistent) -> -8 AgentNotFound
await send('register id=12 token 999999 (nonexistent)', 'register_payable', registerParam({ id: 12, payee: buyerB, amount: 1_000_000, asset: assetCcd(), dueMs: DUE7D, docHash: DOC(12), token: 999999, expected: null, legal: null }), 0, -8);
// 6. register id=13 due in the past -> -7 PastDue
await send('register id=13 due past', 'register_payable', registerParam({ id: 13, payee: buyerB, amount: 1_000_000, asset: assetCcd(), dueMs: now - 3600_000, docHash: DOC(13), token: 1476, expected: null, legal: null }), 0, -7);
// 7. register id=14 expected_payer == seller -> -27 SelfAction
await send('register id=14 expected_payer=seller', 'register_payable', registerParam({ id: 14, payee: buyerB, amount: 1_000_000, asset: assetCcd(), dueMs: DUE7D, docHash: DOC(14), token: 1476, expected: addr, legal: null }), 0, -27);
// 8. register P2 (CCD 5) -> SUCCESS
await send('register P2 CCD 5', 'register_payable', registerParam({ id: 2, payee: buyerB, amount: 5_000_000, asset: assetCcd(), dueMs: DUE7D, docHash: DOC(2), token: 1476, expected: null, legal: null }), 0, null);
// 9. pay P2 with 4 CCD -> -6 WrongAmount (amount checked before the payer guard)
await send('pay P2 with 4 CCD (wrong amount)', 'pay_ccd', keyParam(addr, 2), 4_000_000, -6);
// 10. pay P2 with exact 5 CCD -> -27 SelfAction (amount passed, payer==seller guard fires)
await send('pay P2 exact 5 CCD (payer==seller)', 'pay_ccd', keyParam(addr, 2), 5_000_000, -27);
// 11. pay nonexistent id=999 -> -3 NotFound
await send('pay id=999 (not found)', 'pay_ccd', keyParam(addr, 999), 1_000_000, -3);
// 12. register P3 (PLT 1.00 EUDemo, expected_payer=B) -> SUCCESS
await send('register P3 PLT 1.00 EUDemo (expected=B)', 'register_payable', registerParam({ id: 3, payee: buyerB, amount: 1_000_000, asset: assetPlt('EUDemo'), dueMs: DUE7D, docHash: DOC(3), token: 1476, expected: buyerB, legal: null }), 0, null);
console.log('payable 3:', JSON.stringify(parsePayable(await view('get_payable(3)', 'get_payable', keyParam(addr, 3)))));
// 13. pay P3 (PLT) via pay_ccd -> -4 WrongAsset
await send('pay P3 (PLT) via pay_ccd', 'pay_ccd', keyParam(addr, 3), 1_000_000, -4);
// 14. reserve P3 by deployer (not the expected payer) -> -21 NotExpectedPayer
await send('reserve P3 by deployer (not expected payer)', 'reserve_plt', keyParam(addr, 3), 0, -21);
// 15. register PLT id=15 without expected_payer -> -22 ExpectedPayerRequired
await send('register PLT id=15 no expected_payer', 'register_payable', registerParam({ id: 15, payee: buyerB, amount: 1_000_000, asset: assetPlt('EUDemo'), dueMs: DUE7D, docHash: DOC(15), token: 1476, expected: null, legal: null }), 0, -22);
// 16. approve_vendor (buyer=deployer, seller=deployer) -> -27 SelfAction
await send('approve_vendor seller==buyer', 'approve_vendor', approveParam({ seller: addr, tier: 2, legal: sha('company-legal-ref'), perCap: 100_000_000, periodCap: 1_000_000_000, periodSecs: 86400 }), 0, -27);
// 17. approve_vendor for seller=B -> SUCCESS; view; revoke -> SUCCESS; view None
await send('approve_vendor seller=B', 'approve_vendor', approveParam({ seller: buyerB, tier: 2, legal: sha('company-legal-ref'), perCap: 100_000_000, periodCap: 1_000_000_000, periodSecs: 86400 }), 0, null);
console.log('vendor (deployer,B):', JSON.stringify(parseVendor(await view('get_vendor(deployer,B)', 'get_vendor', vendorParam(addr, buyerB)))));
await send('revoke_vendor seller=B', 'revoke_vendor', ab(buyerB), 0, null);
console.log('vendor (deployer,B) after revoke:', JSON.stringify(parseVendor(await view('get_vendor(deployer,B) post-revoke', 'get_vendor', vendorParam(addr, buyerB)))));
// 18. set_strict(true) -> SUCCESS; view policy; set_strict(false) -> SUCCESS
await send('set_strict(true)', 'set_strict', strictParam(true), 0, null);
const pol1 = await view('get_buyer_policy (strict)', 'get_buyer_policy', ab(addr));
console.log('buyer policy strict byte:', pol1[0]);
await send('set_strict(false)', 'set_strict', strictParam(false), 0, null);
const pol2 = await view('get_buyer_policy (relaxed)', 'get_buyer_policy', ab(addr));
console.log('buyer policy strict byte:', pol2[0]);
results.push({ label: 'buyer policy strict toggle', pass: pol1[0] === 1 && pol2[0] === 0 });
// 19. register P4 (CCD 1) -> SUCCESS; void -> SUCCESS; pay -> -25 Voided; void again -> -5 WrongStatus
await send('register P4 CCD 1', 'register_payable', registerParam({ id: 4, payee: buyerB, amount: 1_000_000, asset: assetCcd(), dueMs: DUE7D, docHash: DOC(4), token: 1476, expected: null, legal: null }), 0, null);
await send('void P4', 'void_payable', voidParam(4), 0, null);
console.log('payable 4:', JSON.stringify(parsePayable(await view('get_payable(4)', 'get_payable', keyParam(addr, 4)))));
await send('pay voided P4', 'pay_ccd', keyParam(addr, 4), 1_000_000, -25);
await send('void P4 again', 'void_payable', voidParam(4), 0, -5);
// 20. register P5 (CCD 1, due +8s) -> SUCCESS; wait; pay exact -> -7 PastDue
const dueP5 = Date.now() + 8000;
await send('register P5 CCD 1 due+8s', 'register_payable', registerParam({ id: 5, payee: buyerB, amount: 1_000_000, asset: assetCcd(), dueMs: dueP5, docHash: DOC(5), token: 1476, expected: null, legal: null }), 0, null);
console.log('waiting 12s for P5 due to pass…');
await sleep(12000);
await send('pay P5 after due', 'pay_ccd', keyParam(addr, 5), 1_000_000, -7);

// final state
console.log('final payable 1:', JSON.stringify(parsePayable(await view('get_payable(1) final', 'get_payable', keyParam(addr, 1)))));
console.log('final payable 2:', JSON.stringify(parsePayable(await view('get_payable(2) final', 'get_payable', keyParam(addr, 2)))));
console.log('final payable 3:', JSON.stringify(parsePayable(await view('get_payable(3) final', 'get_payable', keyParam(addr, 3)))));
console.log('final payable 5:', JSON.stringify(parsePayable(await view('get_payable(5) final', 'get_payable', keyParam(addr, 5)))));
const info1 = await client.getAccountInfo(addr);
const bInfo1 = await client.getAccountInfo(buyerB);
console.log('deployer CCD after:', Number(info1.accountAmount.microCcdAmount) / 1e6, '| nonce:', String(info1.accountNonce?.nonce ?? info1.accountNonce));
console.log('account B CCD after:', Number(bInfo1.accountAmount.microCcdAmount) / 1e6, '(unchanged = no pay succeeded, as expected)');
try {
  const inst = await client.getInstanceInfo(CONTRACT);
  console.log('contract instance info:', JSON.stringify(inst, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 500));
  results.push({ label: 'contract instance balance', instance: JSON.parse(JSON.stringify(inst, (k, v) => (typeof v === 'bigint' ? v.toString() : v))) });
} catch (e) {
  console.log('getInstanceInfo unavailable:', String(e).slice(0, 120));
}
const passed = results.filter((r) => r.pass !== false).length;
console.log(`\nMATRIX DONE: ${passed}/${results.length} cases passed`);
fs.writeFileSync(new URL('./matrix-v2-result.json', import.meta.url), JSON.stringify({ contract: '<13150,0>', deployerCcdBefore: Number(info0.accountAmount.microCcdAmount) / 1e6, deployerCcdAfter: Number(info1.accountAmount.microCcdAmount) / 1e6, accountBCcdBefore: Number(bInfo0.accountAmount.microCcdAmount) / 1e6, accountBCcdAfter: Number(bInfo1.accountAmount.microCcdAmount) / 1e6, passed, total: results.length, results }, null, 2));
