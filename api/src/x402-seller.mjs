// PayOnce sells its own check over x402: GET /api/x402/check-payee?payee=<account>&name=<payee name>[&network=mainnet]
// First call: HTTP 402 with a PAYMENT-REQUIRED header (x402 v2, Concordium testnet, native CCD, sponsored fee).
// Retry with PAYMENT-SIGNATURE: the payment is verified and settled by a facilitator, and only a settled payment gets the verdict.
// The check itself is free elsewhere (/api/check-payee); this route exists so other agents can buy it the way they buy anything
// else, and so PayOnce is a seller on the same rail it checks. Testnet: a small price, the fee is sponsored by PayOnce.
export const X402_VERSION = 2;
export const TESTNET_CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
export const PRICE_MICRO = '10000'; // 0.01 CCD

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{50}$/;

export class SellerError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

/**
 * deps: facilitator { verify(payload, req), settle(payload, req) }, check({payee, legal_name, network}), payTo, feePayer,
 *       resourceUrl(query) -> string, now, seen (Set of settled tx hashes), record(row)
 * Returns { status, headers, body }.
 */
export function createX402Seller(deps) {
  const { facilitator, check, payTo, feePayer, amountMicro = PRICE_MICRO, record = async () => {}, now = Date.now, gate = null } = deps;
  const seen = deps.seen ?? new Set();

  const requirements = () => ({ scheme: 'exact', network: TESTNET_CAIP2, amount: String(amountMicro), asset: 'CCD', payTo, maxTimeoutSeconds: 300, extra: { feePayer } });
  const paymentRequired = (url, error) => {
    const body = { x402Version: X402_VERSION, error, ...(gate ? { buyerGate: { mode: gate.mode, headers: ['X-Buyer-Agent', 'X-Buyer-Mandate'], note: gate.mode === 'required' ? 'Agents only: the paying account must be an Active registry agent with a valid badge (agentWallet = payer) presenting its signed, anchored spend mandate. See /api/mandate.' : 'Optional: present X-Buyer-Agent and X-Buyer-Mandate to be reported as a verified buyer.' } } : {}), resource: { url, description: 'PayOnce check_payee: does this Concordium account belong to the name you were told to pay? MATCH, CLOSE_MATCH, NO_MATCH or UNVERIFIED.', mimeType: 'application/json' }, accepts: [requirements()] };
    return { status: 402, headers: { 'PAYMENT-REQUIRED': b64(body) }, body };
  };

  async function handle({ query = {}, headers = {} }) {
    const payee = String(query.payee ?? ''); const name = String(query.name ?? query.legal_name ?? '').trim();
    if (!ADDR.test(payee)) throw new SellerError(400, 'bad_address', 'payee must be a Concordium account address.');
    if (!name || name.length > 200) throw new SellerError(400, 'bad_name', 'name (the payee name you were told to pay) is required, up to 200 characters.');
    const network = String(query.network ?? '').toLowerCase() === 'mainnet' ? 'mainnet' : undefined;
    const url = deps.resourceUrl(query);

    const sig = headers['payment-signature'] ?? headers['x-payment'];
    if (!sig) return paymentRequired(url, 'Payment required');

    let payload;
    try { payload = unb64(sig); } catch { return paymentRequired(url, 'PAYMENT-SIGNATURE is not base64 JSON'); }
    const req = requirements();
    const acc = payload?.accepted ?? {};
    if (acc.payTo !== req.payTo || String(acc.amount) !== req.amount || acc.network !== req.network || acc.scheme !== 'exact') {
      return paymentRequired(url, 'The payment does not match what was asked (payTo, amount, network, scheme).');
    }

    // The verdict is computed before any money moves: a node error must not cost the buyer anything.
    const result = await check({ payee, seller: payee, legal_name: name, network });

    const v = await facilitator.verify(payload, req);
    if (!v?.isValid) return paymentRequired(url, `Payment not valid: ${v?.invalidReason ?? 'unknown'}`);
    // The merchant verifies the buyer BEFORE settlement: a refusal here costs the buyer nothing.
    let buyer = null;
    if (gate) {
      const g = await gate.check({ headers, payer: v.payer ?? null, amount_micro: req.amount });
      buyer = g.buyer;
      if (!g.ok) return { status: 403, headers: {}, body: { error: { code: 'buyer_not_verified', layer: 'app', message: 'This resource sells only to verified buyer agents. Nothing was charged.', retryable: false }, nothing_charged: true, buyer } };
    }
    const s = await facilitator.settle(payload, req);
    if (!s?.success || !s?.transaction) return paymentRequired(url, `Payment not settled: ${s?.errorReason ?? 'unknown'}`);
    if (seen.has(s.transaction)) return paymentRequired(url, 'This payment was already used.');
    seen.add(s.transaction);
    await record({ at: new Date(now()).toISOString(), payee, name, verdict: result.verdict, tx_hash: s.transaction, payer: s.payer ?? v.payer ?? null, amount_micro: req.amount, ...(buyer ? { buyer_verified: buyer.verified, buyer_agent: buyer.agent?.token ?? null, buyer_mandate: buyer.mandate?.hash ?? null, gate_mode: buyer.mode } : {}) });
    const settlement = { success: true, transaction: s.transaction, network: TESTNET_CAIP2, payer: s.payer ?? v.payer ?? null };
    return { status: 200, headers: { 'PAYMENT-RESPONSE': b64(settlement) }, body: { ...result, epc_verdict: String(result.verdict).toLowerCase(), paid: { amount_ccd: '0.01', tx_hash: s.transaction, explorer_url: `https://ccdexplorer.io/testnet/transaction/${s.transaction}` }, ...(buyer ? { buyer } : {}) } };
  }
  return { handle, requirements };
}
