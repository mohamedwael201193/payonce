// PayOnce API: the payee link. /p/<account> shows who an account is paid as, and anyone (a person or an agent) can
// run check_payee against it. Pure over injected readers, so it is tested offline.
//
//   card(account)            -> { account, exists, verified, name, kind, country?, bound: {...}|null, label, links }
//   check(account, name)     -> the check_payee result for (book seller, account, name)
//
// The name is the one the account's owner chose to reveal from their own wallet (a zero-knowledge proof of the
// first and last name, or of a company legal name). Testnet identities are self-asserted mock identities.
import { VopError } from './vop-service.mjs';

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{50}$/;

export function createPayeeCards({ kv, vop, readBook, readAccount, bookSellers, now = Date.now, appBase = '', apiBase = '' }) {
  function need(account) {
    if (!ADDR.test(String(account ?? ''))) throw new VopError(400, 'bad_address', 'That is not a Concordium account address.');
  }

  async function card(account) {
    need(account);
    const [acct, proof] = await Promise.all([readAccount(account).catch(() => null), kv.get('payee_proof', account).catch(() => null)]);
    let bound = null;
    for (const seller of bookSellers) {
      const rec = await readBook(seller, account).catch(() => null);
      if (rec && rec.status && rec.status !== 'NotBound') {
        const mature = rec.mature_at_ms != null ? Number(rec.mature_at_ms) <= now() : false;
        bound = { seller, status: rec.status, version: rec.version, mature_at_ms: rec.mature_at_ms ?? null, hold_over: rec.status === 'Bound' && mature, kind: rec.identity?.kind === 1 ? 'business' : rec.identity?.kind === 2 ? 'person' : null, idp_index: rec.identity?.idp_index ?? null, proof_anchor: rec.identity?.proof_anchor ?? null };
        if (rec.status === 'Bound') break;
      }
    }
    const verified = Boolean(proof?.name);
    const name = proof?.name ?? null;
    const parts = [];
    if (verified) parts.push(`Verified payee: ${name}`); else parts.push('Unverified payee');
    if (bound?.status === 'Bound') parts.push('bound by the payee’s own signature');
    if (bound?.hold_over) parts.push('hold over');
    if (bound?.version != null) parts.push(`v${bound.version}`);
    return {
      account, exists: acct?.exists ?? null, verified, name, kind: proof?.kind ?? bound?.kind ?? null,
      proof: proof ? { version: proof.version, verified_at: proof.verified_at, issuer: proof.issuer ?? null, vra_tx: proof.vra_tx ?? null, vaa_tx: proof.vaa_tx ?? null } : null,
      bound, label: parts.join(' · '),
      testnet_note: 'Testnet names are self-asserted mock identities. The chain checks the payee’s signature, the hold, the version and pay once; the name proof is checked by a keyless verifier anyone can re-run.',
      links: {
        page: `${appBase}/p/${account}`,
        check_payee: `${apiBase}/api/check-payee?payee=${account}&seller=${bookSellers[0] ?? account}&legal_name=<name on the invoice>`,
        card_json: `${apiBase}/api/p/${account}`,
        pay_with_wallet: `${appBase}/app?payee=${account}`,
      },
    };
  }

  async function check(account, name, extra = {}) {
    need(account);
    const c = await card(account);
    const seller = c.bound?.seller ?? bookSellers[0] ?? account;
    const r = await vop.check({ seller, payee: account, legal_name: name, country: extra.country, buyer: extra.buyer });
    return { ...r, epc_verdict: String(r.verdict).toLowerCase(), card: { label: c.label, verified: c.verified, name: c.name } };
  }

  return { card, check };
}
