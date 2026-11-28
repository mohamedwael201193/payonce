// deploy-v21-verifiable.mjs — deploy the VERIFIABLE build of payable_registry_v2_1
// STATUS: written, NOT run. v2.1 is not being redeployed (v3 replaces it); copy this for v3.
// The box cannot reach Concordium gRPC, so run it from a machine that can.
// (built in docker.io/concordium/verifiable-sc-wasm32v1:1, source link embedded)
// to Concordium TESTNET and init one instance. Testnet only, never mainnet.
// Keys are read from the env file IN-PROCESS ONLY; never printed or written.
// Usage: PAYONCE_ENV_FILE=/path/to/env node deploy-v21-verifiable.mjs
// Writes: deploy-v21-verifiable-result.json (module ref, instance, tx hashes).
// Never resubmits: if a tx does not reach "finalized" it stops and reports the hash.
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { AccountAddress, Transaction, TransactionExpiry, buildBasicAccountSigner, ContractName, CcdAmount, Energy, ModuleReference, Parameter } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const ENV_PATH = process.env.PAYONCE_ENV_FILE;
const MODULE_PATH = new URL('../payable_registry_v2_1/verifiable/payable_registry_v2_1.wasm.v1', import.meta.url);
const EXPECTED_ADDRESS = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const EXPECTED_MODULE_SHA = 'ae5e47f0fa5a057c0e7bffc007c2361d16d4e05a81be217e087778ffb817a1d4';
const CIS8004_INDEX = 12802n;
const RESERVATION_SECS = 3600n;
const OUT = new URL('./deploy-v21-verifiable-result.json', import.meta.url);

if (!ENV_PATH) { console.log('PAYONCE_ENV_FILE not set'); process.exit(1); }
if (fs.existsSync(OUT)) { console.log('result file exists — a deploy already ran; refusing to deploy twice'); process.exit(1); }
const env = {};
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const t = line.replace(/\r$/, '').trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
}
const address = (env.address_wallet || env.CONCORDIUM_WALLET_ADDRESS || '').trim();
const privKey = (env.private_key || env.CONCORDIUM_WALLET_PRIVATE_KEY || '').replace(/^0x/, '').trim();
if (address !== EXPECTED_ADDRESS) { console.log('deployer address mismatch — aborting'); process.exit(1); }
if (!/^[0-9a-fA-F]{64}$/.test(privKey)) { console.log('private key format unexpected — aborting (nothing printed)'); process.exit(1); }

const versioned = fs.readFileSync(MODULE_PATH);
const sha = createHash('sha256').update(versioned).digest('hex');
if (sha !== EXPECTED_MODULE_SHA) { console.log('module sha mismatch', sha); process.exit(1); }
if (versioned.readUInt32BE(0) !== 1 || versioned.readUInt32BE(4) !== versioned.length - 8) { console.log('unexpected module prefix'); process.exit(1); }
const WASM = versioned.subarray(8);

const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const addr = AccountAddress.fromBase58(address);
const signer = buildBasicAccountSigner(privKey);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const result = { network: 'testnet', moduleSha256: sha, buildImage: 'docker.io/concordium/verifiable-sc-wasm32v1:1', sourceLink: 'https://raw.githubusercontent.com/mohamedwael201193/payonce/main/contracts/payable_registry_v2_1/verifiable/payable_registry_v2_1.wasm.v1.tar', txs: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

async function send(build, label) {
  const info = await client.getAccountInfo(addr);
  const fin = await Transaction.signAndFinalize(build(info.accountNonce).build(), signer);
  const h = await client.sendTransaction(fin);
  const hashHex = hex(h.buffer);
  result.txs.push({ label, hash: hashHex, status: 'sent' }); save();
  console.log(`[${label}] sent ${hashHex}`);
  let status = null;
  for (let i = 0; i < 60; i++) { await sleep(2000); status = await client.getBlockItemStatus(h); if (status.status === 'finalized') break; }
  const s = JSON.parse(J(status));
  result.txs.at(-1).status = s.status; result.txs.at(-1).outcome = s.outcome?.summary?.type ?? null; save();
  if (s.status !== 'finalized') { console.log(`[${label}] NOT finalized (${s.status}) — stopping, do not resubmit; check ${hashHex}`); process.exit(2); }
  console.log(`[${label}] finalized, cost ${(Number(s.outcome?.summary?.cost ?? 0) / 1e6).toFixed(6)} CCD`);
  return s;
}
const meta = (nonce) => ({ sender: addr, nonce, expiry: TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)) });
const info0 = await client.getAccountInfo(addr);
console.log('deployer CCD before:', Number(info0.accountAmount.microCcdAmount) / 1e6);

const dep = await send((nonce) => Transaction.deployModule({ source: new Uint8Array(WASM), version: 1 }).addMetadata(meta(nonce)), 'deploy-module');
const moduleRef = dep.outcome?.summary?.moduleDeployed?.contents ?? dep.outcome?.summary?.moduleRef ?? null;
if (!moduleRef) { console.log('deploy did not yield a module ref:', J(dep.outcome?.summary?.rejectReason ?? dep.outcome?.summary ?? {}).slice(0, 400)); process.exit(1); }
result.moduleRef = moduleRef; save();
console.log('moduleRef:', moduleRef);

const initParam = Buffer.alloc(24);
initParam.writeBigUInt64LE(CIS8004_INDEX, 0);
initParam.writeBigUInt64LE(0n, 8);
initParam.writeBigUInt64LE(RESERVATION_SECS, 16);
const init = await send((nonce) => Transaction.initContract({
  amount: CcdAmount.fromMicroCcd(0n), moduleRef: ModuleReference.fromHexString(moduleRef),
  initName: ContractName.fromString('payable_registry_v2_1'), param: Parameter.fromBuffer(initParam),
}, Energy.create(100000n)).addMetadata(meta(nonce)), 'init-contract');
const sum = init.outcome?.summary ?? {};
const index = sum.contractInitialized?.address?.index ?? null;
if (index === null) { console.log('init did not yield an address:', J(sum.rejectReason ?? sum).slice(0, 400)); process.exit(1); }
result.contract = `<${index},0>`; result.contractIndex = Number(index); save();
console.log('DONE', J({ moduleRef, contract: result.contract, txs: result.txs.map((t) => t.hash) }));
