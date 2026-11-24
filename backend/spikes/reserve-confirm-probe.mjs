// READ-ONLY probe: reserve_plt + confirm_plt txs for payable 2, and the live
// get_payable(2) view — grounds the PLT verifier branch (reservation window,
// confirm tx_hash binding, Paid status) before the verifier is written.
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { TransactionHash, ContractAddress, ReceiveName, Parameter } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
import { writeFileSync } from 'node:fs';

const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const replacer = (k, v) => (typeof v === 'bigint' ? v.toString() : v);

const reserve = await client.getBlockItemStatus(TransactionHash.fromHexString('ee56c0cc845880f7875aba6afc794a1becf6a906eec639891ef75d34e8fbefc1'));
const confirm = await client.getBlockItemStatus(TransactionHash.fromHexString('212f0ac79a5ed884dbb9e4fddb5edc45d0411dc0f3f9b8739ab5b4c1ec310bde'));
const view = await client.invokeContract({
  contract: ContractAddress.create(13149n, 0n),
  method: ReceiveName.fromString('payable_registry.get_payable'),
  parameter: Parameter.fromHexString('0200000000000000'),
});
const out = {
  reserve: JSON.parse(JSON.stringify(reserve, replacer)),
  confirm: JSON.parse(JSON.stringify(confirm, replacer)),
  get_payable_2_hex: Buffer.from(view.returnValue.buffer).toString('hex'),
};
for (const [label, s] of [['reserve', reserve], ['confirm', confirm]]) {
  const j = JSON.parse(JSON.stringify(s, replacer));
  const sum = j.outcome?.summary ?? {};
  console.log(`\n===== ${label} =====`);
  console.log('status:', j.status, '| block:', j.outcome?.blockHash?.slice(0, 16));
  console.log('sender:', sum.sender, '| sponsor:', sum.sponsor ?? '(none)');
  console.log('cost:', sum.cost, '| energyCost:', sum.energyCost);
  for (const ev of sum.events ?? []) {
    console.log(' event:', JSON.stringify(ev, replacer).slice(0, 500));
  }
}
console.log('\nget_payable(2) raw hex:', out.get_payable_2_hex);
console.log('get_payable(2) len:', Buffer.from(view.returnValue.buffer).length);
writeFileSync(new URL('./reserve-confirm-output.json', import.meta.url), JSON.stringify(out, replacer, 2));
console.log('written to spikes/reserve-confirm-output.json');
