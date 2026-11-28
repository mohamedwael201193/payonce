// G13 red team: the live attack catalogue against the v3 demo book (testnet) and the PayOnce API.
// Every chain attack is the exact transaction an attacker would send, executed by the node as a dry run
// (InvokeInstance with the attacker's account as invoker): the node runs the real contract on the current
// finalized state and returns the refusal code. Nothing is sent and no fee is paid; the same call can be repeated
// by anyone with a node. Two attacks re-read finalized refusals the demo run really sent (chain records).
// API attacks run the production check_payee / pay-tx / approval code.
import { AccountAddress, ContractAddress, ReceiveName, Parameter, CcdAmount, TransactionHash } from '@concordium/web-sdk';
import { createHash, randomBytes } from 'node:crypto';
import {
  serPayableKey, serRegisterPayable, serAcceptPayee, serPayeeRef, serAcknowledgePayee, getPayeeRecord, getPayableV3, v3Label,
} from './vop-chain.mjs';

export const CODE_NAMES = {
  '-1': 'Unauthorized', '-2': 'Duplicate', '-3': 'NotFound', '-5': 'WrongStatus', '-6': 'WrongAmount', '-7': 'PastDue', '-8': 'AgentNotFound',
  '-10': 'AgentOwnerMismatch', '-14': 'Invalid', '-19': 'NotApprovedVendor', '-21': 'NotExpectedPayer', '-27': 'SelfAction', '-28': 'PayeeNotBound',
  '-29': 'PayeeNotMature', '-30': 'PayeeNotAcknowledged', '-31': 'PayeeChanged', '-32': 'PayeeNotProposed', '-33': 'AnchorMismatch',
  '-34': 'PayeeVersionMismatch', '-35': 'NotPayeeParty', '-36': 'VerdictNotPayable',
};
const transient = (e) => /429|UNAVAILABLE|unavailable|did not answer|timeout|ECONNRESET|DEADLINE/i.test(String(e?.message ?? e));
/** Node reads are retried on rate limits (testnet nodes answer 429 under load); a refusal is never retried away. */
export async function retrying(fn, { tries = 8, baseMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i + 1 >= tries || !transient(e)) throw e; await sleep(Math.min(20_000, baseMs * 2 ** i)); }
  }
}
const J = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const sha = (s) => createHash('sha256').update(s).digest('hex');
/** An alias of `address` (same first 29 bytes, last 3 bytes = n): another address string for the SAME account. */
export function aliasOf(address, n) {
  const b = Buffer.from(AccountAddress.fromBase58(address).decodedAddress);
  return AccountAddress.fromBuffer(Buffer.concat([b.subarray(0, 29), Buffer.from([(n >> 16) & 255, (n >> 8) & 255, n & 255])])).address;
}

/**
 * deps: { client(), book, seller, buyer, token (seller's agent token), fixtures: { X, Y, staleInvoice, recorded: {notMature, payTwice} },
 *         check(input) (production check_payee on this book), payTx(payee, q) (dash pay-tx), approvals, now() }
 */
export function createAttackCatalogue(deps) {
  const { book, seller, buyer } = deps;
  const now = deps.now ?? Date.now;
  const contract = () => ContractAddress.create(book.index, book.subindex);
  async function dry(invoker, entrypoint, param, amountMicro = 0n) {
    const res = await deps.client().invokeContract({
      invoker: AccountAddress.fromBase58(invoker), contract: contract(), method: ReceiveName.fromString(`${book.name}.${entrypoint}`),
      parameter: Parameter.fromBuffer(param), amount: CcdAmount.fromMicroCcd(BigInt(amountMicro)),
    });
    const used = Number(res.usedEnergy?.value ?? res.usedEnergy ?? 0);
    if (res.tag === 'success') return { refused: false, code: null, used_energy: used };
    const code = res.reason?.rejectReason ?? res.reason?.contents?.rejectReason;
    return { refused: true, code: code != null ? Number(code) : null, used_energy: used, reason_tag: res.reason?.tag ?? null };
  }
  async function recorded(hash) {
    const s = J(await deps.client().getBlockItemStatus(TransactionHash.fromHexString(hash)));
    const sum = s.outcome?.summary ?? {};
    const rr = sum.rejectReason?.rejectReason ?? sum.rejectReason?.contents?.rejectReason ?? null;
    return { refused: !!sum.rejectReason, code: rr != null ? Number(rr) : null, status: s.status, block: s.outcome?.blockHash ?? null, tx_hash: hash };
  }

  async function run() {
    const t0 = now();
    const fx = deps.fixtures;
    const R = (f) => retrying(f, deps.retry);
    const inv = await R(() => getPayableV3(deps.client(), seller, fx.staleInvoice, book));
    const paid = await R(() => getPayableV3(deps.client(), seller, fx.paidInvoice, book));
    const open = fx.openInvoice ? await R(() => getPayableV3(deps.client(), seller, fx.openInvoice, book)) : null;
    const ownerRec = await R(() => getPayeeRecord(deps.client(), seller, seller, book));
    const xRec = await R(() => getPayeeRecord(deps.client(), seller, fx.X, book));
    const yRec = await R(() => getPayeeRecord(deps.client(), seller, fx.Y, book));
    const ownerAlias = aliasOf(seller, 0x0a77ac);
    const evidence = sha(`attack evidence ${now()}`);
    const freshId = () => 9_000_000_000_000n + BigInt(`0x${randomBytes(4).toString('hex')}`);
    const reg = (payee, extra = {}) => serRegisterPayable({ payable_id: freshId(), payee, amount: 10_000n, asset: 'CCD', due_ms: now() + 7 * 864e5, doc_hash: sha(`doc ${payee}`), agent_token: deps.token, expected_payer: null, legal_ref: null, ...extra });
    const fixtureFacts = {
      stale_invoice: inv && { id: fx.staleInvoice, payee: inv.payee, payee_version_on_invoice: inv.payee_version, payee_version_now: xRec?.version ?? null, status: inv.status.tag },
      proposed_never_accepted: yRec && { payee: fx.Y, status: yRec.status, version: yRec.version },
      strict_buyer: fx.X,
      open_invoice: open && { id: fx.openInvoice, expected_payer: open.expected_payer, status: open.status.tag },
    };

    const A = [];
    const chain = (id, title, attacker, expect, fn, plain) => A.push({ id, layer: 'chain', method: 'node dry run (InvokeInstance), nothing sent', title, attacker, expect, fn, plain });
    // --- payment attacks ---
    chain('pay-twice', 'Pay an invoice that is already paid', 'buyer agent', [-5], () => dry(buyer, 'pay_ccd', serPayableKey({ seller, payable_id: fx.paidInvoice }), BigInt(paid?.amount ?? 1)), 'A paid invoice cannot be paid again.');
    chain('wrong-amount', 'Pay a different amount than the invoice', 'buyer agent', [-6], () => dry(buyer, 'pay_ccd', serPayableKey({ seller, payable_id: fx.staleInvoice }), BigInt(inv?.amount ?? 0) + 1n), 'The amount must equal the invoice exactly.');
    chain('unknown-invoice', 'Pay an invoice number that does not exist', 'buyer agent', [-3], () => dry(buyer, 'pay_ccd', serPayableKey({ seller, payable_id: 9_999_999_999_999n }), 1n), 'Only invoices on the book can be paid.');
    chain('self-pay', 'Seller pays its own invoice (wash / fake volume)', 'seller', [-27], () => dry(seller, 'pay_ccd', serPayableKey({ seller, payable_id: fx.staleInvoice }), BigInt(inv?.amount ?? 0)), 'A seller cannot pay itself.');
    chain('changed-bank-details', 'Payee details changed after the invoice was issued, then the old invoice is paid', 'buyer agent (victim)', [-31], () => dry(buyer, 'pay_ccd', serPayableKey({ seller, payable_id: fx.staleInvoice }), BigInt(inv?.amount ?? 0)), 'The payee was re-bound after this invoice; the invoice carries the old version, so the chain refuses it (the "changed bank details" fraud).');
    chain('strict-buyer-unapproved-vendor', 'A strict buyer pays a seller it never approved', 'strict buyer', [-19], () => dry(fx.X, 'pay_ccd', serPayableKey({ seller, payable_id: fx.openInvoice }), BigInt(open?.amount ?? 0)), 'A buyer that set strict mode pays only approved sellers.');
    chain('wrong-payer', 'Someone else pays an invoice locked to the buyer agent', 'outsider', [-21], () => dry(fx.stranger, 'pay_ccd', serPayableKey({ seller, payable_id: fx.staleInvoice }), BigInt(inv?.amount ?? 0)), 'An invoice issued to one payer cannot be settled by another account.');
    // --- invoices to the wrong payee ---
    chain('lookalike-address-invoice', 'Invoice to a lookalike address of the real payee (alias, same first 29 bytes)', 'seller (compromised)', [-28], () => dry(seller, 'register_payable', reg(ownerAlias)), `The lookalike ${ownerAlias.slice(0, 6)}…${ownerAlias.slice(-6)} is not the bound payee address; an invoice to it is refused.`);
    chain('unbound-payee-invoice', 'Invoice to an account that was never proposed', 'seller (compromised)', [-28], () => dry(seller, 'register_payable', reg(fx.stranger)), 'Only a payee that accepted the binding can be invoiced.');
    chain('proposed-not-accepted-invoice', 'Invoice to a payee that was proposed but never accepted', 'seller (compromised)', [-28], () => dry(seller, 'register_payable', reg(fx.Y)), 'Proposing is not enough: the payee must sign the acceptance.');
    chain('past-due-invoice', 'Register an invoice that is already past due (backdated)', 'seller', [-7], () => dry(seller, 'register_payable', reg(seller, { due_ms: now() - 864e5 })), 'A backdated invoice is refused.');
    chain('duplicate-invoice-id', 'Re-register an existing invoice number with new details', 'seller', [-2], () => dry(seller, 'register_payable', reg(seller, { payable_id: BigInt(fx.paidInvoice) })), 'Invoice numbers cannot be reused.');
    chain('fake-agent-token', 'Register with an agent token that does not exist', 'seller', [-8], () => dry(seller, 'register_payable', reg(seller, { agent_token: 987_654_321n })), 'Only a registered CIS-8004 agent can invoice.');
    chain('stolen-agent-token', 'An outsider registers an invoice with the seller\'s agent token', 'outsider', [-10], () => dry(fx.stranger, 'register_payable', reg(seller)), 'The agent token belongs to the seller; nobody else can use it.');
    // --- payee binding attacks ---
    chain('accept-without-proposal', 'Accept a payee binding nobody proposed', 'outsider', [-32], () => dry(fx.stranger, 'accept_payee', serAcceptPayee({ seller, version: 1, proof_anchor: sha('x') })), 'An account cannot bind itself as a payee.');
    chain('accept-wrong-proof', 'Accept a proposal with a different name proof (anchor)', 'payee account', [-33], () => dry(fx.Y, 'accept_payee', serAcceptPayee({ seller, version: yRec?.version ?? 1, proof_anchor: sha('another proof') })), 'The payee must accept exactly the proof that was proposed.');
    chain('accept-wrong-version', 'Accept an older or newer version of the proposal', 'payee account', [-34], () => dry(fx.Y, 'accept_payee', serAcceptPayee({ seller, version: (yRec?.version ?? 1) + 5, proof_anchor: yRec?.identity?.proof_anchor ?? sha('x') })), 'The payee must accept the exact version on the book.');
    chain('stranger-revoke', 'An outsider revokes the real payee\'s binding (denial of payment)', 'outsider', [-35], () => dry(fx.stranger, 'revoke_payee', serPayeeRef({ seller, payee: seller })), 'Only the seller or the payee can revoke.');
    // --- acknowledgment attacks ---
    chain('ack-no-match', 'Agent records a No-match verdict as its acknowledgment', 'buyer agent (buggy)', [-36], () => dry(buyer, 'acknowledge_payee', serAcknowledgePayee({ seller, payee: seller, version: ownerRec?.version ?? 1, verdict: 2, evidence_hash: evidence })), 'Only Match or Close match can be acknowledged.');
    chain('ack-unverified', 'Agent records Unverified as its acknowledgment', 'buyer agent (buggy)', [-36], () => dry(buyer, 'acknowledge_payee', serAcknowledgePayee({ seller, payee: seller, version: ownerRec?.version ?? 1, verdict: 3, evidence_hash: evidence })), '"Verification not possible" is never payable.');
    chain('ack-stale-version', 'Agent acknowledges a payee version that is not on the book', 'buyer agent', [-34], () => dry(buyer, 'acknowledge_payee', serAcknowledgePayee({ seller, payee: seller, version: (ownerRec?.version ?? 1) + 7, verdict: 0, evidence_hash: evidence })), 'The acknowledgment must name the current version.');
    chain('payee-self-ack', 'The payee acknowledges itself on behalf of buyers', 'payee', [-27], () => dry(seller, 'acknowledge_payee', serAcknowledgePayee({ seller, payee: seller, version: ownerRec?.version ?? 1, verdict: 0, evidence_hash: evidence })), 'Only a buyer can acknowledge.');
    // --- chain records (finalized refusals the demo run sent) ---
    if (fx.recorded?.notMature) A.push({ id: 'not-mature', layer: 'chain', method: 'finalized refusal re-read from the node', title: 'Pay a freshly bound impostor during the cooling-off', attacker: 'impostor', expect: [-29], fn: () => recorded(fx.recorded.notMature), plain: 'A new payee binding cannot be paid until its cooling-off is over.' });
    if (fx.recorded?.payTwice) A.push({ id: 'pay-twice-sent', layer: 'chain', method: 'finalized refusal re-read from the node', title: 'A second payment really sent', attacker: 'buyer agent', expect: [-5], fn: () => recorded(fx.recorded.payTwice), plain: 'The second payment was sent and refused on chain; nothing moved.' });

    // --- API attacks (production decision code) ---
    const api = (id, title, expect, fn, plain) => A.push({ id, layer: 'api', method: 'production check_payee / pay-tx / approvals', title, attacker: 'impostor', expect, fn, plain });
    const notMatch = (r) => ({ refused: r.verdict !== 'MATCH' || r.payable !== true ? true : false, code: r.verdict, payable: r.payable });
    api('lookalike-name', 'Invoice names the payee "PayOnce Lab" (one letter off)', ['CLOSE_MATCH not payable'], async () => { const r = await deps.check({ seller, payee: seller, legal_name: 'PayOnce Lab' }); return { refused: r.verdict !== 'MATCH' && !r.payable, code: `${r.verdict}${r.payable ? ' payable' : ' not payable'}` }; }, 'A near name is Close match: never paid automatically.');
    api('homoglyph-name', 'Invoice names "PayOnсe Labs" with a Cyrillic с', ['not MATCH'], async () => notMatch(await deps.check({ seller, payee: seller, legal_name: 'PayOn\u0441e Labs' })), 'Lookalike characters are not the proven name.');
    api('lookalike-address-check', 'Real name, lookalike address (alias of the real account)', ['not payable'], async () => notMatch(await deps.check({ seller, payee: ownerAlias, legal_name: 'PayOnce Labs' })), 'The name alone never makes an address payable.');
    api('impostor-account-check', 'Real name claimed by the impostor account', ['not payable'], async () => notMatch(await deps.check({ seller, payee: fx.X, legal_name: 'PayOnce Labs' })), 'An account with no name proof is Verification not possible.');
    api('click-approval', 'Close match paid with a UI click instead of a signed approval', ['needs_signed_approval'], async () => {
      try { await deps.payTx(seller, { payer: buyer, amount_micro: '1000', name: 'PayOnce Lab', approved: '1' }, 'attack-catalogue'); return { refused: false, code: 'built' }; } catch (e) { return { refused: e.code === 'needs_signed_approval', code: e.code ?? String(e.message) }; }
    }, 'A Close match needs the payer\'s wallet signature over the verdict and invoice.');
    api('forged-approval-signature', 'Approval "signed" with a key that is not the payer\'s', ['bad_signature'], async () => {
      const r = await deps.approvals.request({ payer: buyer, payee: seller, name: 'PayOnce Lab', amount_micro: '1000' }, 'attack-catalogue');
      try { await deps.approvals.verify(r.approval_id, { signature: { 0: { 0: randomBytes(64).toString('hex') } } }); return { refused: false, code: 'approved' }; } catch (e) { return { refused: e.code === 'bad_signature', code: e.code ?? String(e.message) }; }
    }, 'The signature is checked against the payer account keys on chain.');

    const results = [];
    for (const a of A) {
      let got;
      try { got = await R(a.fn); } catch (e) { got = { refused: null, code: null, error: String(e?.message ?? e).slice(0, 160) }; }
      const pass = got.refused === true && (a.layer === 'api' ? true : a.expect.includes(got.code));
      results.push({
        id: a.id, layer: a.layer, method: a.method, title: a.title, attacker: a.attacker,
        expected: a.expect.map((c) => (typeof c === 'number' ? `${c} ${CODE_NAMES[String(c)] ?? ''}`.trim() : c)),
        got: got.code == null ? (got.refused === false ? 'ACCEPTED' : got.error ?? null) : typeof got.code === 'number' ? `${got.code} ${CODE_NAMES[String(got.code)] ?? ''}`.trim() : got.code,
        refused: got.refused, pass, plain: a.plain, ...(got.used_energy != null ? { used_energy: got.used_energy } : {}), ...(got.tx_hash ? { tx_hash: got.tx_hash, block: got.block } : {}),
      });
    }
    const passed = results.filter((r) => r.pass).length;
    return {
      generated_at: new Date(now()).toISOString(), took_ms: now() - t0, network: 'Concordium testnet', book: v3Label(book),
      module: deps.moduleRef ?? null, total: results.length, passed, failed: results.length - passed,
      distinct_chain_codes: [...new Set(results.filter((r) => r.layer === 'chain' && r.pass).map((r) => r.got))].length,
      scorecard: `${passed}/${results.length} attacks refused with the expected code`,
      how: 'Chain attacks are the exact transactions an attacker would send, executed by a Concordium node as dry runs (InvokeInstance, invoker = the attacker): the real contract runs on the current state and returns its refusal code. Nothing is sent and no fee is paid. Re-run: GET /api/proof/attacks?fresh=1.',
      fixtures: fixtureFacts, attacks: results,
    };
  }
  return { run };
}
