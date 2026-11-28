// deploy-v3.mjs — deploy + init PayOnce payable_registry_v3 (Verification of
// Payee) on Concordium TESTNET from the verifiable build. Testnet only.
//
// Runs where the testnet gRPC node is reachable (a Render one-off job on the
// payonce-api service: `node api/scripts/deploy-v3.mjs <phase>`).
// Phases: `status` (read only), `deploy` (module, skipped if already on
// chain), `init` (one instance; refuses unless CONFIRM_INIT=1).
// Key: CONCORDIUM_WALLET_PRIVATE_KEY (deployer = owner 42jaZZ…), used
// in-process only, never printed. Prints only public data (hashes, refs).
// Never resubmits: a tx that is not finalized stops the script with its hash.
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import {
  AccountAddress, Transaction, TransactionExpiry, buildBasicAccountSigner, ContractName,
  CcdAmount, Energy, ModuleReference, Parameter, TransactionHash,
} from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const PHASE = process.argv[2] ?? 'status';
const MODULE_PATH = new URL('../../contracts/payable_registry_v3/verifiable/payable_registry_v3.wasm.v1', import.meta.url);
const EXPECTED_ADDRESS = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const EXPECTED_MODULE_SHA = process.env.V3_MODULE_SHA ?? '8641046eb939a5693731b6d79b227a1a4b356d8cf10308baabca0a93a16b3946';
const CIS8004_INDEX = 12802n; // official testnet Agent Registry
const RESERVATION_SECS = 3600n;
const COOLING_OFF_SECS = BigInt(process.env.V3_COOLING_OFF_SECS ?? 600); // demo: 10 minutes

const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const hex = (b) => Buffer.from(b).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const versioned = fs.readFileSync(MODULE_PATH);
const sha = createHash('sha256').update(versioned).digest('hex');
if (sha !== EXPECTED_MODULE_SHA) { console.log('module sha mismatch', sha); process.exit(1); }
if (versioned.readUInt32BE(0) !== 1 || versioned.readUInt32BE(4) !== versioned.length - 8) { console.log('unexpected module prefix'); process.exit(1); }
const WASM = versioned.subarray(8);
console.log('module file sha256', sha, 'bytes', versioned.length);

const client = new ConcordiumGRPCNodeClient(process.env.PAYONCE_GRPC_HOST ?? 'grpc.testnet.concordium.com', Number(process.env.PAYONCE_GRPC_PORT ?? 20000), credentials.createSsl());
const addr = AccountAddress.fromBase58(EXPECTED_ADDRESS);

async function moduleOnChain(ref) {
  try { await client.getModuleSource(ModuleReference.fromHexString(ref)); return true; } catch { return false; }
}

if (PHASE === 'status') {
  const info = await client.getAccountInfo(addr);
  console.log('deployer CCD', Number(info.accountAmount.microCcdAmount) / 1e6, 'nonce', String(info.accountNonce.value ?? info.accountNonce));
  console.log('module on chain (ref = file sha256)?', await moduleOnChain(sha));
  for (const h of process.argv.slice(3)) {
    const s = JSON.parse(J(await client.getBlockItemStatus(TransactionHash.fromHexString(h))));
    console.log('tx', h, s.status, J(s.outcome?.summary ?? {}).slice(0, 600));
  }
  process.exit(0);
}

const privKey = (process.env.CONCORDIUM_WALLET_PRIVATE_KEY || '').replace(/^0x/, '').trim();
if (!/^[0-9a-fA-F]{64}$/.test(privKey)) { console.log('private key missing or malformed (nothing printed)'); process.exit(1); }
const signer = buildBasicAccountSigner(privKey);
const meta = (nonce) => ({ sender: addr, nonce, expiry: TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)) });

async function send(build, label) {
  const info = await client.getAccountInfo(addr);
  const fin = await Transaction.signAndFinalize(build(info.accountNonce).build(), signer);
  const h = await client.sendTransaction(fin);
  const hashHex = hex(h.buffer);
  console.log(`[${label}] sent ${hashHex}`);
  let status = null;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    try { status = await client.getBlockItemStatus(h); } catch { continue; }
    if (status.status === 'finalized') break;
  }
  const s = JSON.parse(J(status ?? {}));
  if (s.status !== 'finalized') { console.log(`[${label}] NOT finalized (${s.status}) — STOP, do not resubmit; check ${hashHex}`); process.exit(2); }
  console.log(`[${label}] finalized ${hashHex} type=${s.outcome?.summary?.type} cost=${(Number(s.outcome?.summary?.cost ?? 0) / 1e6).toFixed(6)} CCD`);
  return { hash: hashHex, s };
}

if (PHASE === 'deploy') {
  if (await moduleOnChain(sha)) { console.log('module already on chain, nothing to do:', sha); process.exit(0); }
  const { hash, s } = await send((n) => Transaction.deployModule({ source: new Uint8Array(WASM), version: 1 }).addMetadata(meta(n)), 'deploy-module');
  const ref = s.outcome?.summary?.moduleDeployed?.contents ?? s.outcome?.summary?.moduleRef ?? null;
  console.log('RESULT', J({ phase: 'deploy', tx: hash, moduleRef: ref, summary: J(s.outcome?.summary ?? {}).slice(0, 500) }));
  process.exit(ref ? 0 : 1);
}

if (PHASE === 'init') {
  if (process.env.CONFIRM_INIT !== '1') { console.log('set CONFIRM_INIT=1 to create the instance (refusing by default)'); process.exit(1); }
  const ref = process.argv[3] ?? sha;
  if (!(await moduleOnChain(ref))) { console.log('module not on chain:', ref); process.exit(1); }
  const p = Buffer.alloc(32);
  p.writeBigUInt64LE(CIS8004_INDEX, 0); p.writeBigUInt64LE(0n, 8);
  p.writeBigUInt64LE(RESERVATION_SECS, 16); p.writeBigUInt64LE(COOLING_OFF_SECS, 24);
  const { hash, s } = await send((n) => Transaction.initContract({
    amount: CcdAmount.fromMicroCcd(0n), moduleRef: ModuleReference.fromHexString(ref),
    initName: ContractName.fromString('payable_registry_v3'), param: Parameter.fromBuffer(p),
  }, Energy.create(30000n)).addMetadata(meta(n)), 'init-contract');
  const sum = s.outcome?.summary ?? {};
  const index = sum.contractInitialized?.address?.index ?? null;
  console.log('RESULT', J({ phase: 'init', tx: hash, contract: index === null ? null : `<${index},0>`, moduleRef: ref, coolingOffSecs: COOLING_OFF_SECS, summary: index === null ? J(sum).slice(0, 500) : undefined }));
  process.exit(index === null ? 1 : 0);
}
console.log('unknown phase', PHASE); process.exit(1);
