// PayOnce QA — READ-ONLY chain verification harness.
// Testnet only. No sends, no signing, no secrets, no keys.
// Verifies: v1 contract <13149,0> + Kinvoice baseline <13148,0> + all 13
// IDEA_V5 §5 tx hashes. Extracts the pay_ccd parameter + Paid event bytes
// so the F10 binding (tx -> payable id) can be proven from chain data alone.
// Usage: node verify-chain.mjs            (full baseline, writes out/baseline-verify.json)
//        node verify-chain.mjs --tx <hash> (single tx dump)
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { TransactionHash, ContractAddress, ReceiveName, Parameter } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const big = (k, v) => (typeof v === 'bigint' ? v.toString() : v);
const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());

const V1 = { index: 13149n, subindex: 0n };
const V1_MODULE = '9b5b27fa7e6d4f40b5a94563b396d8760e2c6eca90eefa91949859be7ae71d24';
const KINVOICE = { index: 13148n, subindex: 0n };

// Full hashes from IDEA_V5_PAYONCE.md §5 (verified source).
export const TX = {
  register_payable: 'd898683668cd8d55fdb2c0ab2505c2d547e137b7955e131b8863d82ad01efb2d',
  pay_ccd: '00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6',
  double_pay_revert: 'a5ec5e4027523c564d81960cb0ec48b546c270ec5f43256f15cf5d34f98d6848',
  wrong_amount_revert: '52f3b4aa09086b27d6c41c3fc4ec10b6bac92f55aa6cc892b55291758b10f01c',
  unknown_id_revert: 'd906c0b3b8bf6333cd0522fed0b39eabae168a2e35029edd9ac5a5b5874dae28',
  reserve_plt: 'ee56c0cc845880f7875aba6afc794a1becf6a906eec639891ef75d34e8fbefc1',
  cosigned_eudemo: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef',
  second_reserve_revert: 'ae62175f96035d23a6df6f84daf89520fd7c534c3a3aa1195ca9af6af752af35',
  confirm_seller: '212f0ac79a5ed884dbb9e4fddb5edc45d0411dc0f3f9b8739ab5b4c1ec310bde',
  reused_txhash_reject: '02ad73477a2e3635f4007ed7bab3c51a4dcd72a97e851fc213a92e6ec577f23b',
  stranger_confirm_reject: '8ee531f203c7e7578749841bf7dd3d8a252ad220745c2921abbf2906f7700e8a',
  early_expiry_reject: '8902c4f12f1c268fc94576b01e1734c8a91e59b631c5857e3fa4a631eb4ef4e7',
  expiry_third_party: '492607926c88c3d9bdcad4edaebd8298c48668d7ee22a0d367cf74b6cdba0760',
};

function summarizeTx(j) {
  // getBlockItemStatus returns { status, outcomes } in the SDK v12 shape.
  const s = j?.status ?? j;
  const outcomes = j?.outcomes ?? j?.outcome ?? null;
  return { status: s, outcomes };
}

async function checkInstance(label, idx, sub, expectModule) {
  try {
    const inst = await client.getInstanceInfo(ContractAddress.create(idx, sub));
    const j = JSON.parse(JSON.stringify(inst, big));
    // sourceModule is a 4-byte length prefix (00000020) + the 32-byte module ref.
    const moduleHash = typeof j?.sourceModule === 'string' ? j.sourceModule.replace(/^00000020/, '') : null;
    const balance = j?.amount ?? null;
    const methods = Array.isArray(j?.methods) ? j.methods.map((m) => String(m).split('.').pop()) : null;
    const ok = {
      exists: true,
      moduleHash,
      moduleMatchesExpected: expectModule ? moduleHash === expectModule : null,
      balanceMicroCcd: balance,
      balanceIsZero: balance === '0' || balance === 0,
      methodCount: methods?.length ?? null,
      methods,
      owner: j?.owner ?? null,
    };
    console.log(`[INSTANCE] ${label} <${idx},${sub}> exists=true module=${String(moduleHash).slice(0, 16)}… match=${ok.moduleMatchesExpected} balance=${balance} methods=${methods?.length}`);
    return { label, index: String(idx), ...ok, raw: j };
  } catch (e) {
    console.log(`[INSTANCE] ${label} <${idx},${sub}> ERROR: ${(e?.message ?? String(e)).slice(0, 200)}`);
    return { label, index: String(idx), exists: false, error: e?.message ?? String(e) };
  }
}

async function checkTx(label, hex) {
  try {
    const st = await client.getBlockItemStatus(TransactionHash.fromHexString(hex));
    const j = JSON.parse(JSON.stringify(st, big));
    const flat = JSON.stringify(j);
    const status = j?.status ?? null;
    const blockHash = j?.outcome?.blockHash ?? null;
    // Extract the pay_ccd Updated event: its `message` IS the parameter
    // (u64 LE payable id) and its `events[0]` is the logged Paid event.
    let payCcdParam = null, paidEvent = null, transferred = null;
    for (const ev of j?.outcome?.summary?.events ?? []) {
      if (ev?.tag === 'Updated' && ev?.receiveName === 'payable_registry.pay_ccd') {
        payCcdParam = ev.message ?? null;
        paidEvent = ev.events?.[0] ?? null;
      }
      if (ev?.tag === 'Transferred') transferred = { from: ev.from, to: ev.to, amount: ev.amount };
    }
    const paramId = payCcdParam ? Number(Buffer.from(payCcdParam, 'hex').readBigUInt64LE(0)) : null;
    console.log(`[TX] ${label} ${hex.slice(0, 12)}… status=${status} block=${String(blockHash).slice(0, 16)}… pay_ccd_param_id=${paramId} forwarded=${transferred ? transferred.amount + ' to ' + String(transferred.to).slice(0, 12) + '…' : '-'}`);
    return { label, hash: hex, status, blockHash, payCcdParam, payCcdParamId: paramId, paidEvent, transferred, raw: j };
  } catch (e) {
    console.log(`[TX] ${label} ${hex.slice(0, 12)}… ERROR: ${(e?.message ?? String(e)).slice(0, 200)}`);
    return { label, hash: hex, status: 'ERROR', error: e?.message ?? String(e) };
  }
}

// F10 binding proof (plan P1 §0, F10): the v1 verifier passed
// `verify 1 <tx-of-payable-4>` with 10/10. That tx is
// 78377f18f61f6ef475bc9176240e876ed18d31e461ffbeb43858a4fb17551a6e
// (from the plan, not from IDEA §5). Fetch it and show, from chain data
// alone, that its pay_ccd parameter is id 4 — so any verifier passing it
// for payable 1 is broken. Also confirm the §5 pay_ccd tx (00e0ac1d…)
// carries parameter id 1 (it is payable 1's payment, correctly verified).
const F10_TX = '78377f18f61f6ef475bc9176240e876ed18d31e461ffbeb43858a4fb17551a6e';
async function f10Evidence() {
  const r = await checkTx('f10_payable4_tx', F10_TX);
  const evidence = {
    tx: F10_TX,
    status: r.status,
    payCcdParamId: r.payCcdParamId,
    claim: 'tx is payable 4 payment; presenting it as proof for payable 1 must FAIL',
    bindingProvableFromChain: r.payCcdParamId === 4,
    section5_pay_ccd_paramId: null,
  };
  console.log(`[F10] tx ${F10_TX.slice(0, 12)}… status=${r.status} pay_ccd_param_id=${r.payCcdParamId} (expect 4) — binding provable from chain: ${evidence.bindingProvableFromChain}`);
  return evidence;
}

async function main() {
  const single = process.argv.includes('--tx') ? process.argv[process.argv.indexOf('--tx') + 1] : null;
  const out = { runAt: new Date().toISOString(), network: 'testnet', instances: {}, txs: {}, f10: null };
  if (single) {
    const r = await checkTx('single', single);
    fs.writeFileSync(path.join(OUT, 'tx-single.json'), JSON.stringify(r, null, 1));
    return;
  }
  out.instances.payable_registry_v1 = await checkInstance('payable_registry_v1', V1.index, V1.subindex, V1_MODULE);
  out.instances.kinvoice_baseline = await checkInstance('kinvoice_baseline', KINVOICE.index, KINVOICE.subindex, null);
  for (const [label, hex] of Object.entries(TX)) out.txs[label] = await checkTx(label, hex);
  out.f10 = await f10Evidence();
  const finalized = Object.values(out.txs).filter((t) => t.status === 'finalized').length;
  console.log(`\n[SUMMARY] instances ok=${Object.values(out.instances).filter((i) => i.exists).length}/2 txs finalized=${finalized}/${Object.keys(TX).length}`);
  fs.writeFileSync(path.join(OUT, 'baseline-verify.json'), JSON.stringify(out, null, 1));
  console.log('[OUT] qa/out/baseline-verify.json');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
