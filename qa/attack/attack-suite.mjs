// PayOnce QA — "try to break it" attack suite (plan P1 §6.1–6.4 negatives + VERDICT_V5 H1/H2/race).
// Testnet only. Read-only chain checks where possible; anything needing the
// v2 contract / co-signer v2 / verifier v2 reports NOT RUN with its blocker.
// Usage: node attack/attack-suite.mjs   (writes out/attack.json)
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { TransactionHash } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QA = path.join(__dirname, '..');
const OUT = path.join(QA, 'out');
fs.mkdirSync(OUT, { recursive: true });
const config = JSON.parse(fs.readFileSync(path.join(QA, 'config.json'), 'utf8'));
const big = (k, v) => (typeof v === 'bigint' ? v.toString() : v);
const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());

// v1 §5 hashes used as the live evidence for attacks that v1 already defends.
const V1 = {
  pay_ccd_payable4: '00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6',
  double_pay_revert: 'a5ec5e4027523c564d81960cb0ec48b546c270ec5f43256f15cf5d34f98d6848',
  wrong_amount_revert: '52f3b4aa09086b27d6c41c3fc4ec10b6bac92f55aa6cc892b55291758b10f01c',
  unknown_id_revert: 'd906c0b3b8bf6333cd0522fed0b39eabae168a2e35029edd9ac5a5b5874dae28',
  second_reserve_revert: 'ae62175f96035d23a6df6f84daf89520fd7c534c3a3aa1195ca9af6af752af35',
  reused_hash_reject: '02ad73477a2e3635f4007ed7bab3c51a4dcd72a97e851fc213a92e6ec577f23b',
  stranger_confirm_reject: '8ee531f203c7e7578749841bf7dd3d8a252ad220745c2921abbf2906f7700e8a',
  early_expiry_reject: '8902c4f12f1c268fc94576b01e1734c8a91e59b631c5857e3fa4a631eb4ef4e7',
  expiry_third_party: '492607926c88c3d9bdcad4edaebd8298c48668d7ee22a0d367cf74b6cdba0760',
};

async function txStatus(hex) {
  try {
    const st = await client.getBlockItemStatus(TransactionHash.fromHexString(hex));
    const j = JSON.parse(JSON.stringify(st, big));
    const s = j?.outcome?.summary ?? {};
    const rr = s.rejectReason ?? null;
    return {
      status: j?.status ?? null,
      txType: s.transactionType ?? null,
      rejectCode: rr?.rejectReason ?? null,
      rejectReceive: rr?.receiveName ?? null,
      rejectParam: rr?.parameter ?? null,
      raw: j,
    };
  } catch (e) {
    return { status: 'ERROR', error: e?.message ?? String(e) };
  }
}

function paramIdLE(hexParam) {
  if (!hexParam || hexParam.length < 16) return null;
  return Number(Buffer.from(hexParam.slice(0, 16), 'hex').readBigUInt64LE(0));
}

const results = { runAt: new Date().toISOString(), network: 'testnet', attacks: {} };
function record(id, name, result, evidence, blocker) {
  results.attacks[id] = { name, result, evidence: evidence ?? null, blocker: blocker ?? null };
  console.log(`[${id}] ${result} — ${name}${evidence ? ' — ' + evidence : ''}${blocker ? ' — blocker: ' + blocker : ''}`);
}

async function main() {
  const v2 = config.v2_contract != null;

  // A-F10 — THE critical bug, chain-level demonstration (RUN NOW).
  // Plan P1 §0 F10: the v1 verifier passed `verify 1 <tx-of-payable-4>`
  // with 10/10. That tx is 78377f18… (from the plan, not IDEA §5).
  // Chain data: its pay_ccd parameter is u64 LE id 4, so a verifier that
  // passes it for payable 1 is broken. The v1 verifier file itself is
  // absent from this workspace, so the verifier re-run is NOT RUN;
  // the chain-data half is RUN here.
  {
    const F10_TX = '78377f18f61f6ef475bc9176240e876ed18d31e461ffbeb43858a4fb17551a6e';
    const r = await txStatus(F10_TX);
    const evs = r.raw?.outcome?.summary?.events ?? [];
    let paramId = null;
    for (const ev of evs) {
      if (ev?.tag === 'Updated' && ev?.receiveName === 'payable_registry.pay_ccd' && ev.message) {
        paramId = Number(Buffer.from(ev.message, 'hex').readBigUInt64LE(0));
      }
    }
    const pay1 = await txStatus(V1.pay_ccd_payable4);
    const evs1 = pay1.raw?.outcome?.summary?.events ?? [];
    let paramId1 = null;
    for (const ev of evs1) {
      if (ev?.tag === 'Updated' && ev?.receiveName === 'payable_registry.pay_ccd' && ev.message) {
        paramId1 = Number(Buffer.from(ev.message, 'hex').readBigUInt64LE(0));
      }
    }
    const bugProven = r.status === 'finalized' && paramId === 4 && paramId1 === 1;
    record(
      'A-F10', 'F10 binding: tx of payable 4 presented as proof for payable 1',
      bugProven ? 'CHAIN-EVIDENCE-RUN' : 'NOT RUN',
      `tx4 ${F10_TX.slice(0, 12)}… finalized, pay_ccd param id=${paramId} (expect 4); §5 pay_ccd tx param id=${paramId1} (expect 1); v1 verifier re-run NOT RUN (verify-payable.mjs absent from workspace)`,
      'v1 verifier file not in workspace (lab files never uploaded)',
    );
  }

  // A5–A12 — v1 reject codes verified FROM THE RECEIPTS (not just "finalized"):
  // each receipt carries RejectedReceive + the numeric code + the parameter.
  for (const [id, name, hash, code, paramId] of [
    ['A5', 'Wrong amount reverts (-6)', V1.wrong_amount_revert, -6, 4],
    ['A6', 'Double pay reverts (-5)', V1.double_pay_revert, -5, 1],
    ['A7', 'Unknown payable id reverts (-3)', V1.unknown_id_revert, -3, 999],
    ['A8', 'Second reservation reverts (-16)', V1.second_reserve_revert, -16, 2],
    ['A9', 'Reused tx hash confirm rejects (-12)', V1.reused_hash_reject, -12, 3],
    ['A10', 'Stranger confirm rejects (-17)', V1.stranger_confirm_reject, -17, 3],
    ['A11', 'Early expiry confirm rejects (-13)', V1.early_expiry_reject, -13, 3],
    ['A12', 'Third-party expiry after window (succeeds)', V1.expiry_third_party, null, 3],
  ]) {
    const r = await txStatus(hash);
    const gotId = paramIdLE(r.rejectParam);
    // A12 is a SUCCESSFUL expire (no reject): the payable id is the
    // `message` (parameter) of its Updated:expire_reservation event.
    const updateId = (() => {
      for (const ev of r.raw?.outcome?.summary?.events ?? []) {
        if (ev?.tag === 'Updated' && ev?.receiveName === 'payable_registry.expire_reservation' && ev.message) {
          return Number(Buffer.from(ev.message, 'hex').readBigUInt64LE(0));
        }
      }
      return null;
    })();
    const codeOk = code === null ? r.rejectCode === null : r.rejectCode === code;
    const idOk = code === null ? updateId === paramId : gotId === paramId;
    const ok = r.status === 'finalized' && codeOk && idOk;
    record(id, name, ok ? 'PASS (v1 live evidence re-verified)' : 'FAIL',
      `https://testnet.ccdscan.io/transactions/${hash} status=${r.status} reject=${r.rejectCode} (expect ${code ?? 'none'}) paramId=${code === null ? updateId : gotId} (expect ${paramId})`);
  }

  // Attacks that need v2 — all NOT RUN until the pieces land.
  const v2Attacks = [
    ['A1', 'H1: fraudster registers a payable for an id the real seller will use / pays a fraudster payable (vendor list + strict)', 'v2 contract + vendor list'],
    ['A2', 'H2: junk confirm — reserve then confirm with a fake/unrelated tx hash; seller must NOT ship', 'v2 contract (seller-names-payer + verifier-based recognition)'],
    ['A3', 'H2: stranger reserves a payable, then the real payer tries to pay', 'v2 contract (expected_payer)'],
    ['A4', 'Race: co-signed transfer held past reservation expiry, confirm lands late; second reservation + second payment', 'v2 contract + co-signer v2 (header-expiry bound)'],
    ['A13', 'Id-squatting F2: attacker registers (seller, id) before the real seller', 'v2 contract (key = seller, id)'],
    ['A14', 'Co-signer: transfer with wrong payee / amount off by one / memo for another payable / memo missing / non-canonical CBOR / two ops / wrong token', 'co-signer v2 decision table (C-19..C-25)'],
    ['A15', 'Co-signer: header.expiry after reservation expiry, or within 60 s of it', 'co-signer v2 (C-28..C-31)'],
    ['A16', 'Co-signer: approval revoked after reserve, before transfer', 'co-signer v2 (C-32)'],
    ['A17', 'Tampered doc_hash: one digit changed in the payee account; verifier must refuse', 'verifier v2'],
    ['A18', 'Void abuse: void Reserved before expiry (-26); void Paid (-5); pay/void a Voided payable (-25)', 'v2 contract (X-01..X-06)'],
    ['A19', 'Cap abuse: per-payable + period cap exceeded on pay and reserve (-23)', 'v2 contract (V-07, V-08)'],
    ['A20', 'Agent revoked after registration, then pay/reserve (-9)', 'v2 contract (R2-06, F-02)'],
  ];
  for (const [id, name, blocker] of v2Attacks) {
    record(id, name, 'NOT RUN', null, v2 ? 'implementation landed but live attack run not executed yet' : blocker);
  }

  fs.writeFileSync(path.join(OUT, 'attack.json'), JSON.stringify(results, null, 1));
  const passed = Object.values(results.attacks).filter((a) => a.result.startsWith('PASS')).length;
  const chainEv = Object.values(results.attacks).filter((a) => a.result === 'CHAIN-EVIDENCE-RUN').length;
  const notRun = Object.values(results.attacks).filter((a) => a.result === 'NOT RUN').length;
  console.log(`\n[SUMMARY] PASS ${passed}, CHAIN-EVIDENCE-RUN ${chainEv}, NOT RUN ${notRun} / ${Object.keys(results.attacks).length}`);
  console.log('[OUT] qa/out/attack.json');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
