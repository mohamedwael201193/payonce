#!/usr/bin/env node
// check-payee <account> --name "Acme ApS" [--seller <acct>] [--api <url>] [--json]
// check-payee x402 <url> --name "Oracle Scout" [--method POST] [--body '{"a":1}'] [--json]
// check-payee card <account> [--json]
// Exit codes: 0 match | 1 no match | 2 close match (ask a person) | 3 verification not possible (ask a person) | 64 usage | 70 error
import { checkPayee, probeX402, payeeCard, DEFAULT_API, CheckPayeeError } from '../src/index.mjs';

const HELP = `check-payee: Verification of Payee for AI agents (Concordium testnet). Never pays.

  check-payee <account> --name "<payee name>" [--seller <account>] [--json]
  check-payee x402 <https url> --name "<who you meant to pay>" [--method GET|POST] [--body <json>] [--json]
  check-payee card <account> [--json]

  --api <url>   default ${DEFAULT_API}  (or env CHECK_PAYEE_API)

Exit: 0 match (pay once) | 1 no match (pay nothing) | 2 close match (ask a person) | 3 verification not possible (ask a person) | 64 usage | 70 error`;

function parse(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json' || a === '--help' || a === '-h') flags[a.replace(/^-+/, '')] = true;
    else if (a.startsWith('--')) { const [k, v] = a.slice(2).split(/=(.*)/s); flags[k] = v ?? argv[++i]; }
    else pos.push(a);
  }
  return { pos, flags };
}

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), env = process.env, fetchImpl } = {}) {
  const { pos, flags } = parse(argv);
  if (flags.help || flags.h || pos.length === 0) { out(HELP); return pos.length ? 0 : 64; }
  const api = (flags.api ?? env.CHECK_PAYEE_API ?? DEFAULT_API).replace(/\/$/, '');
  const common = { api, ...(fetchImpl ? { fetchImpl } : {}) };
  try {
    if (pos[0] === 'card') {
      const c = await payeeCard(pos[1], common);
      out(flags.json ? JSON.stringify(c, null, 2) : `${c.label}\n${c.account}\n${c.testnet_note ?? ''}`);
      return 0;
    }
    if (pos[0] === 'x402') {
      let body; if (flags.body) { try { body = JSON.parse(flags.body); } catch { err('--body must be JSON'); return 64; } }
      const r = await probeX402({ url: pos[1], name: flags.name, method: flags.method ?? (body ? 'POST' : 'GET'), body, ...common });
      if (flags.json) out(JSON.stringify(r, null, 2));
      else if (r.requires_payment === false) out(`${r.url} did not ask for payment (HTTP ${r.status}).`);
      else out([`Seller   ${r.url}`, `Price    ${r.selected?.amount_ccd ?? '?'} CCD`, `Pay to   ${r.selected?.pay_to ?? '?'}`, `Verdict  ${r.verdict ?? 'n/a'}${r.check?.reasons?.[0] ? ` (${r.check.reasons[0]})` : ''}`, `Outcome  ${r.outcome}: ${r.text}`].join('\n'));
      return r.requires_payment === false ? 0 : r.exit;
    }
    const r = await checkPayee({ payee: pos[0], name: flags.name, seller: flags.seller, country: flags.country, ...common });
    if (flags.json) out(JSON.stringify(r, null, 2));
    else out([`Payee    ${pos[0]}`, `Name     ${flags.name}`, `Verdict  ${r.verdict}${r.reasons?.[0] ? ` (${r.reasons[0]})` : ''}`, `Outcome  ${r.outcome}: ${r.text}`].join('\n'));
    return r.exit;
  } catch (e) {
    if (e instanceof CheckPayeeError) { err(`check-payee: ${e.message}`); return /required/.test(e.message) ? 64 : 70; }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-payee')) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`check-payee: ${e?.message ?? e}\n`); process.exit(70); });
}
