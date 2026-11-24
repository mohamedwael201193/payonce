// READ-ONLY: fetch the v1 module schema from chain and schema-decode the
// get_payable return values for payables 1..4. This is the principled decode
// path for the verifier (plan S5) — no byte-guessing.
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import {
  ContractAddress, ReceiveName, Parameter, ModuleReference,
  deserializeReceiveReturnValue, getEmbeddedModuleSchema,
} from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
import { writeFileSync } from 'node:fs';

const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const MODULE = '9b5b27fa7e6d4f40b5a94563b396d8760e2c6eca90eefa91949859be7ae71d24';
const mod = await client.getModuleSource(ModuleReference.fromHexString(MODULE));
const schemaBytes = await getEmbeddedModuleSchema(mod);
console.log('module source bytes:', Buffer.from(mod.source.buffer).length);
console.log('embedded schema:', schemaBytes ? `${schemaBytes.length} bytes` : 'NONE');
if (!schemaBytes) { console.log('ABORT: no embedded schema'); process.exit(1); }

const out = {};
for (const id of [1, 2, 3, 4]) {
  const param = id.toString(16).padStart(2, '0') + '00000000000000';
  const r = await client.invokeContract({
    contract: ContractAddress.create(13149n, 0n),
    method: ReceiveName.fromString('payable_registry.get_payable'),
    parameter: Parameter.fromHexString(param),
  });
  const raw = Buffer.from(r.returnValue.buffer);
  try {
    const decoded = deserializeReceiveReturnValue(raw, schemaBytes, 'payable_registry', 'get_payable');
    out[id] = decoded;
    console.log(`\n== payable ${id} (schema-decoded) ==`);
    console.log(JSON.stringify(decoded, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  } catch (e) {
    console.log(`\n== payable ${id}: schema decode FAILED: ${(e?.message ?? String(e)).slice(0, 300)} ==`);
    out[id] = { decodeError: String(e?.message ?? e).slice(0, 300), rawHex: raw.toString('hex') };
  }
}
writeFileSync(new URL('./schema-decode-output.json', import.meta.url), JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log('\nwritten to spikes/schema-decode-output.json');
