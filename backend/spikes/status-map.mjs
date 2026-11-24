// READ-ONLY: map the get_payable status byte across payables 1,3,4 + the
// registry balance + config (reservation window). Grounds the verifier's
// status checks without needing the contract schema.
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { ContractAddress, ReceiveName, Parameter } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';

const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
for (const id of [1, 3, 4]) {
  const param = id.toString(16).padStart(2, '0') + '00000000000000';
  const r = await client.invokeContract({
    contract: ContractAddress.create(13149n, 0n),
    method: ReceiveName.fromString('payable_registry.get_payable'),
    parameter: Parameter.fromHexString(param),
  });
  const hex = Buffer.from(r.returnValue.buffer).toString('hex');
  console.log(`payable ${id}: len=${r.returnValue.buffer.length} first16=${hex.slice(0, 32)} tail32=${hex.slice(-64)}`);
}
const info = await client.getInstanceInfo(ContractAddress.create(13149n, 0n));
const j = JSON.parse(JSON.stringify(info, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
console.log('instance balance microCCD:', j.amount ?? j.balance ?? JSON.stringify(j).slice(0, 300));
console.log('instance keys:', Object.keys(j).join(', '));
