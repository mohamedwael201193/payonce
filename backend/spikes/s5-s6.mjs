// S5 + S6 spikes (READ-ONLY, no sends) — plan P1 §8.1.
// S5: encoding of `Updated.parameter` for pay_ccd (u64 little-endian) and of the
//     contract's logged `Paid` event, decoded from the live v1 txs.
// S6: which field carries block time / slot time in getBlockItemStatus.
// Target txs (v1 contract <13149,0>, from PAYABLE_LOG / IDEA_V5 §5):
//   00e0ac1d... = pay_ccd for payable 1 (0.5 CCD to payee 4gedLUop...)
//   78377f18... = pay_ccd for payable 4 (the F10 cross-invoice tx)
//   7cc2f94f... = co-signed EUDemo 0.01, memo payable:2 (Rail B)
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { TransactionHash, BlockHash } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
import { writeFileSync } from 'node:fs';

const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const replacer = (k, v) => (typeof v === 'bigint' ? v.toString() : v);
const TXS = {
  pay_ccd_payable1: '00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6',
  pay_ccd_payable4: '78377f18f61f6ef475bc9176240e876ed18d31e461ffbeb43858a4fb17551a6e',
  eudemo_payable2: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef',
};

const out = {};
for (const [label, hash] of Object.entries(TXS)) {
  const status = await client.getBlockItemStatus(TransactionHash.fromHexString(hash));
  const j = JSON.parse(JSON.stringify(status, replacer));
  out[label] = j;
  console.log(`\n===== ${label} (${hash.slice(0, 8)}…) =====`);
  console.log('top-level keys:', Object.keys(j).join(', '));
  // web-sdk v12 shape: { status, outcome: { blockHash, summary } }
  const o = j.outcome?.summary ?? j.outcome ?? j;
  console.log('summary keys:', Object.keys(o).join(', '));
  console.log('status:', j.status);
  const blockHash = j.outcome?.blockHash;
  if (blockHash) console.log('blockHash:', blockHash);
  // Transaction payload / parameter
  const tx = j.transaction ?? o.transaction;
  if (tx) {
    console.log('tx keys:', Object.keys(tx).join(', '));
    const payload = tx.payload ?? tx;
    console.log('payload keys:', Object.keys(payload).join(', '));
    if (payload.parameter) console.log('parameter:', JSON.stringify(payload.parameter).slice(0, 400));
    if (payload.message) console.log('message:', JSON.stringify(payload.message).slice(0, 400));
    if (payload.receiveName) console.log('receiveName:', payload.receiveName);
    if (payload.address) console.log('address:', JSON.stringify(payload.address));
  }
  // Events produced by the outcome
  const events = o.events ?? [];
  console.log('events count:', events.length);
  events.forEach((ev, i) => {
    console.log(`  [${i}] type:`, ev.type ?? ev['@type'] ?? Object.keys(ev).join(','));
    console.log(`      `, JSON.stringify(ev, replacer).slice(0, 800));
  });
  // Block time via getBlockInfo on the containing block (S6 cross-check)
  if (blockHash) {
    const info = await client.getBlockInfo(BlockHash.fromHexString(blockHash));
    const bi = JSON.parse(JSON.stringify(info, replacer));
    console.log('blockInfo keys:', Object.keys(bi).join(', '));
    console.log('blockSlotTime:', bi.blockSlotTime, '| height:', bi.blockHeight);
    out[label].blockSlotTime = bi.blockSlotTime;
    out[label].blockHeight = bi.blockHeight;
  }
}
writeFileSync(new URL('./s5-s6-output.json', import.meta.url), JSON.stringify(out, replacer, 2));
console.log('\nFull JSON written to spikes/s5-s6-output.json');
