// PayOnce QA — 13-step end-to-end testnet runner (plan P1 §6.4, steps E0–E12).
// Testnet only. Read-only where possible; steps that SEND are gated behind
// --execute and record every tx hash + reject code in out/e2e.json.
// Without --execute the runner only checks PRECONDITIONS and reports
// NOT RUN for every step whose piece has not landed yet.
// Usage: node e2e/run-e2e.mjs            (precondition check, no sends)
//        node e2e/run-e2e.mjs status     (print the step table from out/e2e.json)
//        node e2e/run-e2e.mjs --execute  (full live run; needs v2 contract + backend + keys on the ops host)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QA = path.join(__dirname, '..');
const OUT = path.join(QA, 'out');
fs.mkdirSync(OUT, { recursive: true });
const config = JSON.parse(fs.readFileSync(path.join(QA, 'config.json'), 'utf8'));

// Step table from plan P1 §6.4. Each step: precondition (what must exist) + expected result.
const STEPS = [
  { id: 'E0', name: 'MCP tool creates order + register_payable', needs: ['mcp_url'], expect: 'Order id and payable key returned' },
  { id: 'E1', name: 'Deploy v2 module and init', needs: ['v2_contract'], expect: 'Module + instance addresses; registry balance 0' },
  { id: 'E2', name: 'Buyer approve_vendor + set_strict(true)', needs: ['v2_contract'], expect: 'VendorApproved, StrictSet' },
  { id: 'E3', name: 'Seller registers one CCD + one PLT payable (expected_payer=C3)', needs: ['v2_contract'], expect: 'Registered x2' },
  { id: 'E4', name: 'Payable from unapproved seller, wallet pay, strict on', needs: ['v2_contract'], expect: '-19; no money moves' },
  { id: 'E5', name: 'Correct pay_ccd', needs: ['v2_contract'], expect: 'Paid; verifier all PASS' },
  { id: 'E6', name: 'PLT reserve_plt by C3, co-signed', needs: ['v2_contract'], expect: 'Reserved; co-signer SIGN recorded' },
  { id: 'E7', name: 'Co-signed transfer, header expiry bounded', needs: ['v2_contract'], expect: 'finalized; one TokenTransfer with memo payable:<seller>:<id>' },
  { id: 'E8', name: 'Co-signed confirm', needs: ['v2_contract'], expect: 'PltConfirmed; verifier all PASS' },
  { id: 'E9', name: 'Refusals, no tx sent: wrong payee/amount/memo/payer/cap/revoked', needs: ['v2_contract'], expect: 'each REFUSE with its code' },
  { id: 'E10', name: 'Race drill: reserve; co-sign; hold confirm past expiry', needs: ['v2_contract'], expect: 'confirm -24; expire -> Unpaid; verifier PAYMENT FOUND, STATUS NOT RECORDED; re-reserve co-sign REFUSE (memo_scan)' },
  { id: 'E11', name: 'Void: Unpaid ok, Reserved unexpired -26, Reserved expired ok', needs: ['v2_contract'], expect: 'as stated' },
  { id: 'E12', name: 'Receipt: payable key + payment tx + verifier output + consent ref', needs: ['v2_contract'], expect: 'out/receipt-<order>.json; verifier re-run on receipt passes' },
];

function preconditionMet(step) {
  const missing = step.needs.filter((k) => config[k] == null);
  return { met: missing.length === 0, missing };
}

function loadResults() {
  const p = path.join(OUT, 'e2e.json');
  if (!fs.existsSync(p)) return { runAt: null, execute: false, steps: {} };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function printTable(results) {
  console.log(`\nPayOnce E2E — plan P1 §6.4 (runAt: ${results.runAt ?? 'never run'})`);
  console.log('ID   RESULT   STEP');
  for (const s of STEPS) {
    const r = results.steps?.[s.id];
    const res = r?.result ?? 'NOT RUN';
    const note = r?.evidence ?? r?.reason ?? '';
    console.log(`${s.id}  ${res.padEnd(8)} ${s.name}${note ? ' — ' + note : ''}`);
  }
  const green = STEPS.filter((s) => results.steps?.[s.id]?.result === 'PASS').length;
  console.log(`\nPASS ${green}/${STEPS.length}. Exit criterion (plan §6.4): all steps green TWICE in a row on fresh payables.`);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'status') { printTable(loadResults()); return; }
  const execute = process.argv.includes('--execute');
  const results = { runAt: new Date().toISOString(), execute, network: 'testnet', steps: {} };
  for (const s of STEPS) {
    const pre = preconditionMet(s);
    if (!pre.met) {
      results.steps[s.id] = { result: 'NOT RUN', reason: `missing config: ${pre.missing.join(', ')} (see qa/config.json)` };
      console.log(`[${s.id}] NOT RUN — missing: ${pre.missing.join(', ')}`);
      continue;
    }
    if (!execute) {
      results.steps[s.id] = { result: 'NOT RUN', reason: 'precondition met but --execute not passed; no sends in check mode' };
      console.log(`[${s.id}] NOT RUN — precondition met, needs --execute (live run on ops host)`);
      continue;
    }
    // Live execution of each step is implemented by the backend/ops agent's
    // run-e2e.mjs in the repo; this QA runner records its output.
    // Until that implementation lands, an --execute run is refused loudly
    // rather than faked.
    results.steps[s.id] = { result: 'NOT RUN', reason: 'live step implementation (repo e2e/run-e2e.mjs) not landed yet' };
    console.log(`[${s.id}] NOT RUN — live step implementation not landed yet`);
  }
  fs.writeFileSync(path.join(OUT, 'e2e.json'), JSON.stringify(results, null, 1));
  printTable(results);
  console.log('[OUT] qa/out/e2e.json');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
