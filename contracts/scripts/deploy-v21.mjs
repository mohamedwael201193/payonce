// deploy-v21.mjs — Deploy payable_registry_v2_1 to Concordium TESTNET and init it.
// Reads keys from the Concordium env file IN-PROCESS ONLY (the same file the
// backend uses); keys are never printed, logged, or written anywhere.
// Testnet only, never mainnet.
// Usage: node deploy-v21.mjs
// Writes: deploy-v21-result.json (module ref, contract address, tx hashes).
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { AccountAddress, Transaction, TransactionExpiry, buildBasicAccountSigner, ContractAddress, ContractName, CcdAmount, Energy, ModuleReference, Parameter } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const ENV_PATH = '/home/hatch/workspace/concordium-trusted-agents/.env';
const WASM_PATH = new URL('../payable_registry_v2_1/payable_registry_v2_1.raw.wasm', import.meta.url);
const EXPECTED_ADDRESS = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const CIS8004_INDEX = 12802n;
const RESERVATION_SECS = 3600n;

// --- read env (in-process only; never print values) ---
const env = {};
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const t = line.replace(/\r$/, '').trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}
const address = (env.CONCORDIUM_WALLET_ADDRESS || '').trim();
const privKey = (env.CONCORDIUM_WALLET_PRIVATE_KEY || '').replace(/^0x/, '').trim();
if (address !== EXPECTED_ADDRESS) {
  console.log('ADDRESS MISMATCH: env CONCORDIUM_WALLET_ADDRESS does not equal the expected deployer address — aborting.');
  process.exit(1);
}
if (!privKey || !/^[0-9a-fA-F]{64}$/.test(privKey)) {
  console.log('private key missing or not 64 hex chars — aborting (key format unexpected; nothing printed).');
  process.exit(1);
}

const WASM = fs.readFileSync(WASM_PATH);
const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const addr = AccountAddress.fromBase58(address);
const signer = buildBasicAccountSigner(privKey);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');
const log = [];

async function send(txBuilder, label) {
  const info = await client.getAccountInfo(addr);
  const tx = txBuilder(info.accountNonce);
  const fin = await Transaction.signAndFinalize(tx.build(), signer);
  const tSend = Date.now();
  const h = await client.sendTransaction(fin);
  const hashHex = hex(h.buffer);
  console.log(`[${label}] SENT: ${hashHex}`);
  let status = null;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    status = await client.getBlockItemStatus(h);
    if (status.status === 'finalized') break;
  }
  const sj = JSON.stringify(status, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const energyUsed = JSON.parse(sj).outcome?.energyCost?.value ?? JSON.parse(sj).outcome?.energy ?? null;
  const costMicro = JSON.parse(sj).outcome?.cost ?? null;
  console.log(`[${label}] final: ${status.status} in ${((Date.now() - tSend) / 1000).toFixed(1)}s, energy ${energyUsed}, cost ${costMicro != null ? (Number(costMicro) / 1e6).toFixed(6) + ' CCD' : 'n/a'}`);
  log.push({ label, hash: hashHex, status: status.status, energyUsed, summary: sj.slice(0, 1400) });
  return { hashHex, status, sj };
}
const meta = (nonce) => ({ sender: addr, nonce, expiry: TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)) });
const info0 = await client.getAccountInfo(addr);
console.log('CCD before:', Number(info0.accountAmount.microCcdAmount) / 1e6, '| nonce:', String(info0.accountNonce?.nonce ?? info0.accountNonce), '| wasm bytes:', WASM.length, '| wasm sha256:', createHash('sha256').update(WASM).digest('hex'));

// 1) deploy module (V1) — raw wasm, prefix stripped (proven by merge round + v2)
const dep = await send(
  (nonce) => Transaction.deployModule({ source: new Uint8Array(WASM), version: 1 }).addMetadata(meta(nonce)),
  'deploy-module',
);
const moduleRef = JSON.parse(dep.sj).outcome?.summary?.moduleDeployed?.contents ?? JSON.parse(dep.sj).outcome?.summary?.moduleRef ?? null;
console.log('moduleRef:', moduleRef);
if (!moduleRef) { console.log('DEPLOY FAILED to yield a moduleRef — aborting.'); process.exit(1); }

// 2) init: InitParam { cis8004: <12802,0>, reservation_secs: 3600 } = 24 bytes LE
const initParam = Buffer.alloc(24);
initParam.writeBigUInt64LE(CIS8004_INDEX, 0);
initParam.writeBigUInt64LE(0n, 8);
initParam.writeBigUInt64LE(RESERVATION_SECS, 16);
const initRes = await send(
  (nonce) => Transaction.initContract({
    amount: CcdAmount.fromMicroCcd(0n),
    moduleRef: ModuleReference.fromHexString(moduleRef),
    initName: ContractName.fromString('payable_registry_v2_1'),
    param: Parameter.fromBuffer(initParam),
  }, Energy.create(100000n)).addMetadata(meta(nonce)),
  'init-contract',
);
const initSummary = JSON.parse(initRes.sj).outcome?.summary ?? {};
// NOTE: in web-sdk v12 the init address lives at summary.contractInitialized.address.
const contractIndex = initSummary.contractInitialized?.address?.index ?? initSummary.address?.index ?? initSummary.contractAddress?.index ?? null;
console.log('contract address:', JSON.stringify(initSummary.address ?? initSummary.contractAddress ?? null));
if (contractIndex === null) { console.log('INIT FAILED to yield an address — aborting.'); process.exit(1); }

const result = {
  moduleRef,
  contract: `<${contractIndex},0>`,
  wasmBytes: WASM.length,
  wasmSha256: createHash('sha256').update(WASM).digest('hex'),
  wasmPrefixedSha256: createHash('sha256').update(fs.readFileSync(new URL('../payable_registry_v2_1/payable_registry_v2_1.wasm.v1', import.meta.url))).digest('hex'),
  deployTx: dep.hashHex,
  initTx: initRes.hashHex,
  log,
};
fs.writeFileSync(new URL('./deploy-v21-result.json', import.meta.url), JSON.stringify(result, null, 2));
console.log('DEPLOY DONE:', JSON.stringify({ moduleRef, contract: result.contract, deployTx: dep.hashHex, initTx: initRes.hashHex }, null, 2));
