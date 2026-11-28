// G20: the deployed v3 module IS the committed verifiable build. Checks, keyless:
//   1. sha256(committed versioned module) == the module reference the live books run (8641046e...);
//   2. the module the testnet node serves for that reference is byte-identical to the committed file;
//   3. both v3 instances (<13172,0> live book, <13173,0> demo book) run that module reference.
// The rebuild-from-source half (pinned Concordium image) is `cargo concordium verify-build` in ci.yml.
//   node scripts/verify-module.mjs [path-to-wasm.v1] [expected-ref]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ModuleReference, ContractAddress } from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

const file = process.argv[2] ?? new URL('../../contracts/payable_registry_v3/verifiable/payable_registry_v3.wasm.v1', import.meta.url);
const EXPECT = process.argv[3] ?? '8641046eb939a5693731b6d79b227a1a4b356d8cf10308baabca0a93a16b3946';
const INSTANCES = [[13172n, 0n, 'live book'], [13173n, 0n, 'demo book']];
const bytes = readFileSync(file);
const ref = createHash('sha256').update(bytes).digest('hex');
const fails = [];
console.log(`committed module sha256 ${ref}`);
if (ref !== EXPECT) fails.push(`committed module hash ${ref} != expected ${EXPECT}`);
const c = new ConcordiumGRPCNodeClient(process.env.PAYONCE_GRPC_HOST ?? 'grpc.testnet.concordium.com', Number(process.env.PAYONCE_GRPC_PORT ?? 20000), credentials.createSsl(), { timeout: 20000 });
const src = await c.getModuleSource(ModuleReference.fromHexString(EXPECT));
const onChain = Buffer.from(src.source);
const version = Number(String(src.version).replace(/\D/g, '') || src.version);
const local = bytes.subarray(8);
console.log(`node module ${EXPECT}: version ${src.version}, ${onChain.length} bytes`);
if (version !== bytes.readUInt32BE(0)) fails.push(`version differs: node ${src.version}, file ${bytes.readUInt32BE(0)}`);
if (!onChain.equals(local)) fails.push(`node module bytes differ from the committed file (${onChain.length} vs ${local.length})`);
for (const [i, s, label] of INSTANCES) {
  const info = await c.getInstanceInfo(ContractAddress.create(i, s));
  const m = info.sourceModule?.moduleRef ?? info.sourceModule?.toString?.() ?? String(info.sourceModule);
  const hex = typeof m === 'string' ? m : Buffer.from(m).toString('hex');
  console.log(`<${i},${s}> ${label}: module ${hex}`);
  if (hex !== EXPECT) fails.push(`<${i},${s}> runs ${hex}, not ${EXPECT}`);
}
if (fails.length) { console.error(`VERIFY FAILED\n- ${fails.join('\n- ')}`); process.exit(1); }
console.log('VERIFIED: committed source build == module on chain == module both v3 books run');
process.exit(0);
