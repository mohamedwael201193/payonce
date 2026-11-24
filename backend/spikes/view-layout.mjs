// READ-ONLY: locate known byte-strings inside the get_payable views of
// payables 1..4 to infer the v1 view layout (payee, amount, due, doc_hash,
// status, payer, tx_hash). No schema is embedded in the v1 module (S5),
// so the verifier decodes structurally from these validated offsets.
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { ContractAddress, ReceiveName, Parameter, AccountAddress } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';

const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const KNOWN_ADDR = {
  seller_4Mvd: '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs',
  payee1_4ged: '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin',
  payer_C3: '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n',
  payee2_4Vtd: '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg',
  owner_42ja: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB',
};
const addrBytes = {};
for (const [k, v] of Object.entries(KNOWN_ADDR)) addrBytes[k] = Buffer.from(AccountAddress.toBuffer(AccountAddress.fromBase58(v)));

const views = {};
for (const id of [1, 2, 3, 4]) {
  const param = id.toString(16).padStart(2, '0') + '00000000000000';
  const r = await client.invokeContract({
    contract: ContractAddress.create(13149n, 0n),
    method: ReceiveName.fromString('payable_registry.get_payable'),
    parameter: Parameter.fromHexString(param),
  });
  views[id] = Buffer.from(r.returnValue.buffer);
}
const TX2 = Buffer.from('7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef', 'hex');

for (const [id, buf] of Object.entries(views)) {
  console.log(`\n== payable ${id} (len ${buf.length}) ==`);
  console.log('hex:', buf.toString('hex'));
  for (const [k, nb] of Object.entries(addrBytes)) {
    let i = buf.indexOf(nb);
    const hits = [];
    while (i !== -1) { hits.push(i); i = buf.indexOf(nb, i + 1); }
    if (hits.length) console.log(`  ${k} at byte offset(s): ${hits.join(',')}`);
  }
  for (const amt of [500000, 10000]) {
    const needle = Buffer.alloc(8); needle.writeBigUInt64LE(BigInt(amt));
    let i = buf.indexOf(needle);
    const hits = [];
    while (i !== -1) { hits.push(i); i = buf.indexOf(needle, i + 1); }
    if (hits.length) console.log(`  u64 ${amt} at offset(s): ${hits.join(',')}`);
  }
  const txi = buf.indexOf(TX2);
  if (txi !== -1) console.log(`  tx_hash 7cc2f94f… at offset: ${txi}`);
  // u64 timestamps in the plausible range (ms epoch 2026-11-24 ± 30 days)
  for (let off = 0; off + 8 <= buf.length; off++) {
    const v = buf.readBigUInt64LE(off);
    if (v >= 1790000000000n && v <= 1800000000000n) {
      console.log(`  u64 ms-timestamp ${v} (${new Date(Number(v)).toISOString()}) at offset ${off}`);
    }
    if (v >= 1790000000n && v <= 1800000000n) {
      console.log(`  u64 s-timestamp ${v} (${new Date(Number(v) * 1000).toISOString()}) at offset ${off}`);
    }
  }
}
