// Runs inside the GitHub Action: reads C_* env, calls the check_payee package, writes step outputs and a summary.
import { appendFileSync } from 'node:fs';
import { checkPayee, probeX402, decide, DEFAULT_API } from '../check-payee/src/index.mjs';

const e = process.env;
const out = (k, v) => { if (e.GITHUB_OUTPUT) appendFileSync(e.GITHUB_OUTPUT, `${k}=${String(v ?? '').replace(/\r?\n/g, ' ')}\n`); };
const fail = (m) => { process.stdout.write(`::error::${m.replace(/\r?\n/g, ' ')}\n`); process.exit(1); };

if (!!e.C_URL === !!e.C_PAYEE) fail('Set exactly one of `url` (an x402 seller) or `payee` (a Concordium account).');
let body; if (e.C_BODY) { try { body = JSON.parse(e.C_BODY); } catch { fail('`body` must be JSON.'); } }
const network = String(e.C_NETWORK || 'testnet').toLowerCase();
if (!['testnet', 'mainnet'].includes(network)) fail('`network` is testnet or mainnet.');
// The check-payee package has no network argument yet (another worker owns it), so a mainnet account check calls the API directly.
// Same endpoint, same four outcomes; mainnet is identity-only: never MATCH.
async function mainnetCheck() {
  const api = (e.C_API || DEFAULT_API).replace(/\/$/, '');
  const res = await fetch(`${api}/api/check-payee?network=mainnet&payee=${encodeURIComponent(e.C_PAYEE)}&legal_name=${encodeURIComponent(e.C_NAME)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
  return { ...j, ...decide(j.verdict), verdict: j.verdict };
}
let r;
try {
  r = e.C_URL
    ? await probeX402({ url: e.C_URL, name: e.C_NAME, method: e.C_METHOD || 'GET', body, api: e.C_API })
    : network === 'mainnet' ? await mainnetCheck() : await checkPayee({ payee: e.C_PAYEE, name: e.C_NAME, api: e.C_API });
} catch (err) { fail(`check_payee could not run: ${err.message}`); }

if (e.C_URL && r.requires_payment === false) { out('outcome', 'not_possible'); out('action', 'ask_human'); fail(`${e.C_URL} did not return an x402 payment request (HTTP ${r.status}).`); }
const payTo = r.selected?.pay_to ?? r.pay_to ?? e.C_PAYEE;
out('verdict', r.verdict); out('outcome', r.outcome); out('action', r.action); out('pay_to', payTo); out('price_ccd', r.selected?.amount_ccd ?? '');
const reason = r.check?.reasons?.[0] ?? r.reasons?.[0] ?? '';
const line = `check_payee: ${r.verdict} (${r.outcome}) for ${e.C_NAME} -> ${payTo}${r.selected ? `, ${r.selected.amount_ccd} CCD` : ''}${reason ? `. ${reason}` : ''}`;
process.stdout.write(`${line}\n${r.text}\n`);
if (e.GITHUB_STEP_SUMMARY) appendFileSync(e.GITHUB_STEP_SUMMARY, `### PayOnce check_payee\n\n| | |\n|---|---|\n| Verdict | **${r.verdict}** (${r.outcome}) |\n| Name | ${e.C_NAME.replace(/\|/g, '/')} |\n| Pay to | \`${payTo}\` |\n${r.selected ? `| Price | ${r.selected.amount_ccd} CCD |\n` : ''}| What an agent may do | ${r.text} |\n\n${(r.mode === 'identity_only' || network === 'mainnet') ? 'Mainnet: read-only identity check (never a match, nothing can be paid from here). ' : ''}Testnet names are self-asserted mock identities; the chain does not verify the ZK proof, a keyless verifier does.\n`);
const failOn = String(e.C_FAIL ?? 'no_match,close_match,not_possible').split(',').map((s) => s.trim()).filter(Boolean);
if (r.outcome !== 'match' && failOn.includes(r.outcome)) { process.stdout.write(`::error::${r.text}\n`); process.exit(1); }
