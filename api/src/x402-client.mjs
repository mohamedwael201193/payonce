// PayOnce API: the buyer side of x402 with Verification of Payee on every payTo.
//
//   probe({ url, method, body, name })   GET/POST the seller WITHOUT paying: read its 402, run check_payee on payTo
//                                         and return the verdict plus the decision (pay / ask_human / refuse).
//   buy({ url, ..., name, approved })     the same probe, then, only if the decision allows it, build the sponsored
//                                         CCD transfer (the seller's facilitator pays the fee), retry with the
//                                         PAYMENT-SIGNATURE header and return the seller's answer + the transaction.
//
// Four outcomes, as EU banks show them since 9 Oct 2025 (Reg. 2024/886):
//   match         -> pay once                    close_match   -> a human decides
//   no_match      -> pay nothing                 not_possible  -> a human decides (no proof to check against)
// A human decision is the `approved: true` flag, which the caller may set only after a person said yes for THIS
// seller, payTo and amount. It never turns a no_match into a payment.
//
// Everything that touches the network or the key is injected, so the whole decision matrix is unit-tested offline.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class X402Error extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

export const X402_POLICY = Object.freeze({
  testnetNetworks: ['ccd:4221332d34e1694168c2a0c0b3fd0f27', 'ccd:4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796'],
  mainnetNetworks: ['ccd:9dd9ca4d19e9393877d2c44b70f89acb', 'ccd:9dd9ca4d19e9393877d2c44b70f89acb8b2a4ce4ff0ec3db9aca48b3f0e0f5ad'],
  maxAmountMicro: 2_500_000n, // 2.5 CCD per purchase, testnet only
  maxBodyBytes: 256 * 1024,
  timeoutMs: 20_000,
  perIpPerHour: 4,
  perDay: 24,
});

export const OUTCOME = Object.freeze({ MATCH: 'match', CLOSE_MATCH: 'close_match', NO_MATCH: 'no_match', NOT_POSSIBLE: 'not_possible' });
const FROM_VERDICT = { MATCH: OUTCOME.MATCH, CLOSE_MATCH: OUTCOME.CLOSE_MATCH, NO_MATCH: OUTCOME.NO_MATCH, UNVERIFIED: OUTCOME.NOT_POSSIBLE };

/** check_payee verdict -> the four outcomes and what the agent may do. Pure. */
export function decide({ verdict, payable = false, standin = false }, { approved = false } = {}) {
  const outcome = FROM_VERDICT[verdict] ?? OUTCOME.NOT_POSSIBLE;
  if (outcome === OUTCOME.NO_MATCH) return { outcome, action: 'refuse', human_can_override: false, why: 'No match: the receiving account does not belong to the name you gave. Nothing is sent.' };
  if (outcome === OUTCOME.MATCH) {
    // An x402 payee has no payee-book row for this buyer, so `payable` can be false for a MATCH that is not bound
    // yet: pay only when the full check says payable, otherwise a human decides.
    if (payable && !standin) return { outcome, action: 'pay', human_can_override: false, why: 'Match: the account proved this name. Pay once.' };
    return approved ? { outcome, action: 'pay', human_can_override: true, why: 'Match, not bound to a payee book yet; a person approved this payment.' } : { outcome, action: 'ask_human', human_can_override: true, why: 'Match, but the payee is not bound and cooled off yet (or is a labelled stand-in): a person decides.' };
  }
  if (outcome === OUTCOME.CLOSE_MATCH) return approved ? { outcome, action: 'pay', human_can_override: true, why: 'Close match; a person approved this payment.' } : { outcome, action: 'ask_human', human_can_override: true, why: 'Close match: the name is nearly the same, not the same. A person decides.' };
  return approved ? { outcome, action: 'pay', human_can_override: true, why: 'Verification was not possible; a person approved this payment.' } : { outcome, action: 'ask_human', human_can_override: true, why: 'Verification not possible: nothing proves who owns the receiving account. A person decides.' };
}

// ---- 402 parsing ----
const b64json = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));

/** Normalise a 402 (x402 v2 PAYMENT-REQUIRED header or JSON body; v1 body best effort) to { version, resource, accepts[] }. */
export function parsePaymentRequired({ headers, bodyText }) {
  let doc = null;
  const h = typeof headers?.get === 'function' ? headers.get('payment-required') : headers?.['payment-required'];
  if (h) { try { doc = b64json(h); } catch { doc = null; } }
  if (!doc && bodyText) { try { doc = JSON.parse(bodyText); } catch { doc = null; } }
  const accepts = Array.isArray(doc?.accepts) ? doc.accepts : [];
  if (!accepts.length) throw new X402Error(502, 'not_x402', 'The seller answered 402 but did not say how to pay (no accepts list).');
  return {
    version: Number(doc.x402Version ?? 1),
    resource: doc.resource ?? null,
    accepts: accepts.map((a) => ({ ...a, amount: String(a.amount ?? a.maxAmountRequired ?? ''), asset: a.asset ?? 'CCD' })),
    raw: doc,
  };
}

/** Pick the one requirement this buyer may pay: exact scheme, native CCD, Concordium testnet, within the cap. */
export function pickRequirement(accepts, policy = X402_POLICY) {
  const reasons = [];
  for (const a of accepts) {
    if (a.scheme !== 'exact') { reasons.push(`scheme ${a.scheme} is not supported`); continue; }
    if (!policy.testnetNetworks.includes(String(a.network))) { reasons.push(`network ${a.network} is not Concordium testnet`); continue; }
    if (String(a.asset).toUpperCase() !== 'CCD') { reasons.push(`asset ${a.asset} is not supported here (native CCD only)`); continue; }
    if (!/^\d+$/.test(a.amount)) { reasons.push('amount is not an integer'); continue; }
    if (BigInt(a.amount) > policy.maxAmountMicro) { reasons.push(`${microToCcd(a.amount)} CCD is above the ${microToCcd(policy.maxAmountMicro)} CCD cap`); continue; }
    if (!/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(String(a.payTo ?? ''))) { reasons.push('payTo is not a Concordium account'); continue; }
    if (!a.extra?.feePayer) { reasons.push('the seller names no fee payer (not sponsored)'); continue; }
    return { requirement: a, reasons };
  }
  return { requirement: null, reasons };
}

export const microToCcd = (m) => { const n = BigInt(m); const s = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, ''); return `${n / 1_000_000n}${s ? `.${s}` : ''}`; };

// ---- SSRF guard ----
const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) return PRIVATE_V4.some((r) => r.test(ip));
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')) return true;
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  return m ? isPrivateAddress(m[1]) : false;
}
export async function assertPublicUrl(url, { resolve = lookup } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new X402Error(400, 'bad_url', 'That is not a URL.'); }
  if (u.protocol !== 'https:') throw new X402Error(400, 'bad_url', 'Only https:// sellers are allowed.');
  if (u.username || u.password) throw new X402Error(400, 'bad_url', 'No credentials in the URL.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new X402Error(400, 'bad_url', 'That host is not public.');
  const addrs = isIP(host) ? [{ address: host }] : await resolve(host, { all: true }).catch(() => { throw new X402Error(400, 'bad_url', 'That host does not resolve.'); });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new X402Error(400, 'bad_url', 'That host is not public.');
  return u;
}

async function readCapped(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, max);
  const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { chunks.push(value.slice(0, value.length - (n - max))); try { await reader.cancel(); } catch { /* ignore */ } break; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * deps: {
 *   fetch(url, init)             defaults to global fetch,
 *   checkPayee({seller,payee,legal_name,buyer?})   -> check_payee result (vop.check),
 *   buildPayload({ requirement, resource })        -> x402 PaymentPayload (sender-signed sponsored transfer),
 *   record?(entry)               persist a purchase record,
 *   resolve?                     DNS lookup (tests),
 *   now?
 * }
 */
export function createX402Client(deps) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  async function call(u, { method, body, headers }) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), X402_POLICY.timeoutMs);
    try {
      const res = await doFetch(u.toString(), { method, headers: { accept: 'application/json', ...(body != null ? { 'content-type': 'application/json' } : {}), ...headers }, body: body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined, signal: ctl.signal, redirect: 'manual' });
      return { res, bodyText: await readCapped(res, X402_POLICY.maxBodyBytes) };
    } catch (e) {
      if (e instanceof X402Error) throw e;
      throw new X402Error(502, 'seller_unreachable', `The seller did not answer (${String(e?.name === 'AbortError' ? 'timeout' : e?.message ?? e).slice(0, 100)}).`);
    } finally { clearTimeout(t); }
  }

  async function probe({ url, method = 'GET', body, name }) {
    const claimed = String(name ?? '').trim();
    if (!claimed || claimed.length > 200) throw new X402Error(400, 'bad_name', 'name (who you meant to pay) is required, up to 200 characters.');
    const m = String(method).toUpperCase();
    if (!['GET', 'POST'].includes(m)) throw new X402Error(400, 'bad_method', 'method is GET or POST.');
    const u = await assertPublicUrl(url, { resolve: deps.resolve });
    const first = await call(u, { method: m, body });
    const out = { url: u.toString(), method: m, name: claimed, status: first.res.status, paid: false };
    if (first.res.status !== 402) {
      return { ...out, requires_payment: false, note: first.res.status === 200 ? 'The seller answered without asking for payment.' : `The seller answered HTTP ${first.res.status}, not a 402 payment request.`, decision: { outcome: OUTCOME.NOT_POSSIBLE, action: 'refuse', human_can_override: false, why: 'There is no x402 payment request to check.' } };
    }
    const pr = parsePaymentRequired({ headers: first.res.headers, bodyText: first.bodyText });
    const { requirement, reasons } = pickRequirement(pr.accepts);
    const shown = pr.accepts[0];
    const payTo = (requirement ?? shown)?.payTo;
    const base = { ...out, requires_payment: true, x402_version: pr.version, resource: pr.resource, accepts: pr.accepts.map((a) => ({ scheme: a.scheme, network: a.network, asset: a.asset, amount: a.amount, amount_ccd: /^\d+$/.test(a.amount) ? microToCcd(a.amount) : null, pay_to: a.payTo })), pay_to: payTo ?? null };
    if (!requirement) {
      // A Concordium MAINNET payTo: PayOnce never pays on mainnet, but the receiving account can still be checked (identity-only).
      const mn = pr.accepts.find((a) => String(a.network).startsWith('ccd:9dd9ca4d') && /^[1-9A-HJ-NP-Za-km-z]{50}$/.test(String(a.payTo ?? '')));
      if (mn) {
        const mcheck = await deps.checkPayee({ network: 'mainnet', payee: mn.payTo, legal_name: claimed });
        const d = decide({ verdict: mcheck.verdict, payable: false });
        return { ...base, network: 'mainnet', selected: null, check: summarize(mcheck), decision: { ...d, action: d.outcome === OUTCOME.NO_MATCH ? 'refuse' : 'ask_human', human_can_override: false, why: `Mainnet payTo: read-only identity check (${mcheck.verdict}). PayOnce does not pay on mainnet, so nothing can be sent from here. ${d.why}` } };
      }
    }
    if (!requirement) return { ...base, check: null, decision: { outcome: OUTCOME.NOT_POSSIBLE, action: 'refuse', human_can_override: false, why: `PayOnce cannot pay this request: ${reasons.join('; ') || 'no usable payment option'}.` } };
    const check = await deps.checkPayee({ seller: payTo, payee: payTo, legal_name: claimed });
    return { ...base, selected: { amount: requirement.amount, amount_ccd: microToCcd(requirement.amount), pay_to: payTo, network: requirement.network }, check: summarize(check), decision: decide(check), _requirement: requirement, _resource: pr.resource, _check: check };
  }

  async function buy({ url, method = 'GET', body, name, approved = false, buyer = null }) {
    const p = await probe({ url, method, body, name });
    const strip = ({ _requirement, _resource, _check, ...rest }) => rest;
    if (!p.requires_payment || !p._requirement) return strip(p);
    const d = decide(p._check, { approved: approved === true });
    if (d.action !== 'pay') return { ...strip(p), decision: d, paid: false, note: d.action === 'ask_human' ? 'Nothing was paid. A person must approve this seller, account and amount.' : 'Nothing was paid.' };
    // The buyer's own signed spend mandate decides next. A person's "yes" never lifts it.
    let auth = null;
    if (deps.mandate) {
      auth = await deps.mandate.authorize({ amount_micro: p._requirement.amount, pay_to: p.pay_to ?? p._requirement.payTo, purpose: p.url });
      if (!auth.ok) {
        const rec = { at: new Date(now()).toISOString(), url: p.url, name: p.name, pay_to: p._requirement.payTo, amount_ccd: microToCcd(p._requirement.amount), outcome: 'refused_by_mandate', mandate_code: auth.code, mandate: auth.mandate ?? null, paid: false };
        await deps.record?.(rec);
        return { ...strip(p), decision: { outcome: d.outcome, action: 'refuse', human_can_override: false, why: auth.reason, code: auth.code }, paid: false, refused_by: 'spend_mandate', mandate: auth.mandate ?? null, note: 'Nothing was signed and nothing was sent: the spend mandate refused this purchase.' };
      }
    }
    let payload;
    try { payload = await deps.buildPayload({ requirement: p._requirement, resource: p._resource }); }
    catch (e) { if (auth?.reservation) await deps.mandate.settle(auth.reservation, { released: true }); throw e; }
    const header = Buffer.from(JSON.stringify(payload)).toString('base64');
    const u = await assertPublicUrl(url, { resolve: deps.resolve });
    // The signed transaction is sent once. A retry of an unknown outcome would double-pay: never retry here.
    const second = await call(u, { method: p.method, body, headers: { 'payment-signature': header, ...(auth?.headers ?? {}) } });
    let settlement = null;
    const ph = second.res.headers?.get?.('payment-response');
    if (ph) { try { settlement = b64json(ph); } catch { settlement = null; } }
    const tx = settlement?.transaction ?? settlement?.txHash ?? settlement?.transactionHash ?? null;
    const delivered = second.res.status >= 200 && second.res.status < 300;
    const rec = { at: new Date(now()).toISOString(), url: p.url, name: p.name, pay_to: p.pay_to, amount_ccd: p.selected.amount_ccd, outcome: d.outcome, verdict: p.check?.verdict ?? null, evidence_hash: p.check?.evidence_hash ?? null, approved_by_human: approved === true && d.human_can_override, http_status: second.res.status, tx_hash: tx, delivered, buyer };
    if (auth?.reservation) await deps.mandate.settle(auth.reservation, { tx_hash: tx, released: !tx && second.res.status === 402 });
    await deps.record?.(rec);
    return { ...strip(p), ...(auth ? { mandate: auth.mandate } : {}), decision: d, paid: delivered || Boolean(tx), settlement, tx_hash: tx, explorer_url: tx ? `https://ccdexplorer.io/testnet/transaction/${tx}` : null, http_status: second.res.status, delivered, response_preview: second.bodyText.slice(0, 1500), record: rec };
  }

  const publicProbe = async (args) => { const { _requirement, _resource, _check, ...rest } = await probe(args); return rest; };
  return { probe: publicProbe, buy };
}

function summarize(c) {
  if (!c) return null;
  return { verdict: c.verdict, epc_verdict: String(c.verdict ?? '').toLowerCase(), payable: c.payable, verified_name: c.verified_name ?? null, identity_kind: c.identity_kind ?? null, standin: !!c.standin, reasons: c.reasons ?? [], checks: c.checks ?? [], evidence_hash: c.evidence_hash ?? null, checked_at: c.checked_at ?? null };
}
