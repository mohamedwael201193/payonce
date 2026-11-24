// Save live fixtures for the verifier negative tests (read-only).
// Fixtures are snapshots of real testnet state; negatives mutate copies.
import { mkdirSync, writeFileSync } from 'node:fs';
import { grpcClient, getTxStatus, getBlockTime } from '../src/chain.mjs';
import { getPayable, getRegistryBalance } from '../src/registry.mjs';
import { decodeLoggedEvents } from '../src/events.mjs';

const client = grpcClient();
const dir = new URL('../test/fixtures/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const write = (name, v) =>
  writeFileSync(`${dir}${name}`, typeof v === 'string' ? v : JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x), 2));

// CCD: payable 1 + pay_ccd tx 00e0ac1d…
const ccdTx = '00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6';
const ccd = await getTxStatus(client, ccdTx);
write('ccd-payable1-tx.json', ccd);
write('ccd-payable1-blockTime.json', await getBlockTime(client, ccd.blockHash));
write('ccd-payable1-view.json', await getPayable(client, 1));
write('ccd-balance.txt', String(await getRegistryBalance(client)));

// Cross-invoice tx for N-01: pay_ccd for payable 4.
const crossTx = '78377f18f61f6ef475bc9176240e876ed18d31e461ffbeb43858a4fb17551a6e';
const cross = await getTxStatus(client, crossTx);
write('ccd-payable4-tx.json', cross);
write('ccd-payable4-blockTime.json', await getBlockTime(client, cross.blockHash));

// PLT: payable 2 + EUDemo tx 7cc2f94f… + reserve + confirm.
const pltTx = '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef';
const plt = await getTxStatus(client, pltTx);
write('plt-payable2-tx.json', plt);
write('plt-payable2-blockTime.json', await getBlockTime(client, plt.blockHash));
write('plt-payable2-view.json', await getPayable(client, 2));
const reserveTx = 'ee56c0cc845880f7875aba6afc794a1becf6a906eec639891ef75d34e8fbefc1';
const rs = await getTxStatus(client, reserveTx);
const rbt = await getBlockTime(client, rs.blockHash);
const upd = (rs.summary?.events ?? []).find(
  (e) => e.tag === 'Updated' && String(e.address?.index) === '13149' && e.receiveName === 'payable_registry.reserve_plt',
);
write('plt-payable2-reserve.json', { blockTime: rbt, logged: upd ? decodeLoggedEvents(upd) : [] });
const confirmTx = '212f0ac79a5ed884dbb9e4fddb5edc45d0411dc0f3f9b8739ab5b4c1ec310bde';
const cs = await getTxStatus(client, confirmTx);
write('plt-payable2-confirm.json', { blockTime: await getBlockTime(client, cs.blockHash) });
write('plt-balance.txt', String(await getRegistryBalance(client)));
console.log('fixtures written to test/fixtures/');
