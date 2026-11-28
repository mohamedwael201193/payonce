// Seller-side gate for PayOnce's x402 sale (the merchant verifies the buyer, as in Peter's W2 answer). Testnet.
//
// The payer is the account that SIGNED the payment (the facilitator reads it from the signed transaction), so the buyer
// identity is not a claim in a header: the headers only say which agent and which mandate to look up.
//   1. X-Buyer-Agent   the registry token of the buyer agent: it must exist on <12802,0>, be Active, be owned by the
//                      payer, have the payer as its agentWallet, and pass the official badge check
//   2. X-Buyer-Mandate the sha256 of the buyer's signed, anchored spend mandate: verified for this price
// mode 'required' refuses a buyer that fails either (HTTP 403, before settlement, nothing charged);
// mode 'optional' still sells and reports `buyer.verified:false` with the reasons.
export class GateRefusal extends Error { constructor(buyer) { super('buyer_not_verified'); this.buyer = buyer; } }

const NEEDED = ['exists', 'active', 'owner', 'mcp_agent_of', 'agent_wallet', 'badge'];

/** deps: { checkBuyer({ tokenId, payer }) -> merchantCheckBuyer result, mandates { verifyForSale }, mode: 'required'|'optional' } */
export function createBuyerGate(deps) {
  const mode = deps.mode ?? 'optional';
  async function check({ headers = {}, payer, amount_micro }) {
    const reasons = [];
    const tokenRaw = headers['x-buyer-agent']; const mandateRaw = headers['x-buyer-mandate'];
    const out = { mode, payer: payer ?? null, agent: null, mandate: null, verified: false, reasons };
    const token = /^\d{1,9}$/.test(String(tokenRaw ?? '')) ? Number(tokenRaw) : null;
    if (!payer) reasons.push('the facilitator did not name the payer');
    if (token == null) reasons.push('X-Buyer-Agent (the buyer agent\u2019s registry token) was not presented');
    if (!mandateRaw) reasons.push('X-Buyer-Mandate (the hash of the buyer\u2019s signed spend mandate) was not presented');
    if (payer && token != null) {
      try {
        const r = await deps.checkBuyer({ tokenId: token, payer });
        const byId = Object.fromEntries((r.checks ?? []).map((c) => [c.id, c.status]));
        const bad = NEEDED.filter((id) => byId[id] !== 'ok');
        out.agent = { token, verdict: r.verdict, checks: Object.fromEntries(NEEDED.map((id) => [id, byId[id] ?? 'missing'])), badge: r.evidence?.badge ?? null };
        if (r.verdict !== 'pass' || bad.length) reasons.push(`buyer agent ${token} did not pass: ${bad.length ? bad.join(', ') : 'registry checks failed'} (it must be Active, owned by the paying account, with that account as agentWallet and a valid badge)`);
      } catch (e) { reasons.push(`buyer agent could not be checked (${String(e?.message ?? e).slice(0, 120)})`); }
    }
    if (payer && mandateRaw) {
      try {
        const m = await deps.mandates.verifyForSale({ hash: String(mandateRaw), token, payer, amount_micro });
        out.mandate = m.mandate ?? { hash: String(mandateRaw) };
        if (!m.ok) reasons.push(...m.reasons.map((x) => `mandate: ${x}`));
      } catch (e) { reasons.push(`mandate could not be checked (${String(e?.message ?? e).slice(0, 120)})`); }
    }
    out.verified = reasons.length === 0;
    return { ok: mode === 'required' ? out.verified : true, buyer: out };
  }
  return { check, mode };
}
