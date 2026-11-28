// Verification of Payee guard: the rule an agent applies before EVERY payment.
// Pure function, no I/O, no model. The planner (scripted or an LLM) may ask
// to pay; this guard decides. A fooled model cannot widen it.
//
// Inputs:
//   check    — the check_payee result for (seller, payee, invoice name) (GET /api/vop/check)
//   payable  — the on-chain v3 payable the agent is about to pay ({ seller, payee, payee_version, amount, asset })
//   message  — the invoice / e-mail text the request came from (data, never instructions)
//   mandate  — { allowStandin: boolean } (testnet stand-in names are refused unless the owner allowed them)
// Output: { allow: true } or { allow: false, code, reason, alert? }.

const ADDR_RE = /\b[1-9A-HJ-NP-Za-km-z]{50}\b/g;
const CHANGE_RE = /\b(new|changed|updated|different)\b[^.\n]{0,60}\b(bank|account|payment|wallet|iban|details|address)\b|\b(bank|account|payment|wallet)\b[^.\n]{0,40}\b(has|have)\s+changed\b/i;

export const VOP_RULES = Object.freeze([
  'the payee comes from the chain (the v3 payable), never from an e-mail or invoice text',
  'check_payee must answer MATCH for exactly this seller, payee and invoice name',
  'the payee must be bound by its own signature and past its cooling-off (payable=true)',
  'the payee-book version checked must be the version the payable was registered against',
  'a message that names another account or announces changed bank details is refused and reported to the owner',
  'CLOSE_MATCH stops and asks the owner; NO_MATCH and UNVERIFIED are refused',
  'testnet stand-in names are refused unless the owner allowed them for the demo',
]);

export function vopGuard({ check, payable, message = '', mandate = {} }) {
  if (!check || !payable) return { allow: false, code: 'vop_not_checked', reason: 'check_payee was not run for this payment.' };
  const accounts = [...new Set(String(message).match(ADDR_RE) ?? [])];
  const foreign = accounts.filter((a) => a !== payable.payee && a !== payable.seller);
  if (foreign.length || CHANGE_RE.test(String(message))) {
    return {
      allow: false, code: 'payee_changed_by_message', alert: true,
      reason: foreign.length
        ? `The message asks to pay ${foreign[0].slice(0, 10)}…, which is not the payee bound on chain (${payable.payee.slice(0, 10)}…). Payment details are never taken from messages; the owner is alerted.`
        : 'The message announces changed payment details. PayOnce never takes payment details from messages; the owner is alerted.',
    };
  }
  if (check.subject?.seller !== payable.seller || check.subject?.payee !== payable.payee) {
    return { allow: false, code: 'vop_wrong_subject', reason: 'The VoP check was for another seller or payee than the payable.' };
  }
  if (check.verdict === 'NO_MATCH') return { allow: false, code: 'payee_no_match', alert: true, reason: `No match: ${check.reasons?.[0] ?? 'the payee account does not belong to the invoiced name.'}` };
  if (check.verdict === 'UNVERIFIED') return { allow: false, code: 'payee_unverified', reason: `Verification not possible: ${check.reasons?.[0] ?? 'no identity proof for this payee.'}` };
  if (check.verdict === 'CLOSE_MATCH') return { allow: false, code: 'ask_owner_close_match', ask: true, reason: `Close match: the verified name is "${check.verified_name}". The owner must confirm.` };
  if (check.verdict !== 'MATCH') return { allow: false, code: 'vop_unknown', reason: `Unknown verdict ${check.verdict}.` };
  if (check.standin && !mandate.allowStandin) return { allow: false, code: 'standin_not_allowed', reason: 'The payee name is a labelled testnet stand-in, not a proven business identity.' };
  if (!check.payable) {
    const failed = (check.checks ?? []).filter((c) => !c.ok).map((c) => c.id);
    return { allow: false, code: failed.includes('cooling_off_over') ? 'payee_cooling_off' : 'payee_not_payable', reason: `Match, but not payable yet: ${failed.join(', ') || 'payee book not bound'}.` };
  }
  if (check.subject?.book?.version != null && payable.payee_version != null && Number(check.subject.book.version) !== Number(payable.payee_version)) {
    return { allow: false, code: 'payee_changed', alert: true, reason: `The payee changed after this invoice was registered (book v${check.subject.book.version}, invoice v${payable.payee_version}).` };
  }
  return { allow: true, evidence_hash: check.evidence_hash };
}
