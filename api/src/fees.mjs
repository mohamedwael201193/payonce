// G19 fee story: what each PayOnce v3 step costs, who pays, in NRG / CCD / EUR.
// NRG are MEASURED medians of finalized testnet transactions on payable_registry_v3 (wallet-proxy, 28 Nov 2026,
// see docs/FEES.md for the sample and hashes). CCD and EUR are computed live from the chain's own exchange-rate
// parameters (euroPerEnergy x microCCDPerEuro), so the table tracks the peg. Fees are charged on energy USED.
export const MEASURED = [
  { step: 'propose_payee', when: 'once per payee binding (or re-binding)', payer: 'seller', nrg: 2227, sample: 8, example: 'a048180b55c5f48f2b9503328a109e652a5433d7a7837f676334a13e71ce621b' },
  { step: 'accept_payee', when: 'once per payee binding, signed by the payee', payer: 'PayOnce (sponsored)', nrg: 1650, sample: 6, example: 'af5050451edd9a9893c816cddbe9a76c8e03a7c6c51f6b7a0b71710f4c2753c4' },
  { step: 'acknowledge_payee', when: 'once per buyer per payee version (not per invoice)', payer: 'PayOnce (sponsored)', nrg: 1585, sample: 2, example: '629bec439faf9533eee649cede4898e73cfba49b6765d0fd010a3c73498b6f94' },
  { step: 'register_payable', when: 'per invoice', payer: 'seller', nrg: 2210, sample: 17, example: 'c8a8477785186cf3dff32d40e0d225ad3dd2e57ebbf2cd2f1af368010f04cf9d' },
  { step: 'pay_ccd', when: 'per invoice paid (3 calls incl. the CIS-8004 agentOf check)', payer: 'PayOnce (sponsored); the buyer sends only the invoice amount', nrg: 2518, sample: 24, example: '3882844ce22699dbc7ff2aed319388b372fc7c066bf0e17acd3e6ec9dcaa9979' },
  { step: 'refused call (e.g. -29, -5)', when: 'an attack or a blocked retry that is actually sent', payer: 'whoever sends it', nrg: 744, sample: 30, example: '50f94790879aa1b00da2fe83f67f11bbc4643bdd5fbfe0eb26e29d617ebad614' },
  { step: 'registerData receipt-head anchor (PVOH1)', when: 'at most every 6 h, plus right after a signed approval (max 12/day)', payer: 'PayOnce', nrg: 508, sample: 34, example: 'd70984296820186417031a6b53cb97cfe60e390074abd6341f37cebc406eeddd' },
  { step: 'check_payee / dry runs / attack catalogue', when: 'every check', payer: 'nobody (node reads and InvokeInstance)', nrg: 0, sample: null, example: null },
];
const ratio = (r) => Number(r.numerator) / Number(r.denominator);
function find(o, k) { if (o && typeof o === 'object') { for (const [kk, v] of Object.entries(o)) { if (kk === k) return v; const r = find(v, k); if (r !== undefined) return r; } } return undefined; }

export function createFees({ fetchImpl = fetch, now = Date.now, ttlMs = 3600_000 } = {}) {
  const cache = {};
  async function rates(network) {
    const c = cache[network];
    if (c && now() - c.at < ttlMs) return c.v;
    const base = network === 'mainnet' ? 'https://wallet-proxy.mainnet.concordium.software' : 'https://wallet-proxy.testnet.concordium.com';
    const d = await (await fetchImpl(`${base}/v0/chainParameters`)).json();
    const e = find(d, 'euroPerEnergy'); const m = find(d, 'microGTUPerEuro') ?? find(d, 'microCCDPerEuro');
    if (!e || !m) throw new Error(`no exchange-rate parameters from ${network}`);
    const v = { network, eur_per_nrg: ratio(e), ccd_per_eur: ratio(m) / 1e6, ccd_per_nrg: (ratio(e) * ratio(m)) / 1e6, euroPerEnergy: e, microCCDPerEuro: m };
    cache[network] = { at: now(), v };
    return v;
  }
  async function table() {
    const [t, mn] = await Promise.all([rates('testnet'), rates('mainnet').catch(() => null)]);
    const row = (s) => ({ ...s, ccd_testnet: +(s.nrg * t.ccd_per_nrg).toFixed(3), ccd_mainnet: mn ? +(s.nrg * mn.ccd_per_nrg).toFixed(3) : null, eur: +(s.nrg * t.eur_per_nrg).toFixed(4) });
    const steps = MEASURED.map(row);
    const nrg = (name) => MEASURED.find((s) => s.step === name).nrg;
    const perInvoice = nrg('register_payable') + nrg('pay_ccd');
    const perPayee = nrg('propose_payee') + nrg('accept_payee');
    return {
      generated_at: new Date(now()).toISOString(), rates: { testnet: t, mainnet: mn },
      peg_note: 'Concordium fixes the EUR price of energy on chain (euroPerEnergy); CCD per NRG follows the CCD/EUR oracle. Testnet and mainnet use the same peg today, so these testnet measurements are mainnet-representative.',
      steps,
      totals: {
        per_paid_invoice: { nrg: perInvoice, eur: +(perInvoice * t.eur_per_nrg).toFixed(4), ccd: +(perInvoice * t.ccd_per_nrg).toFixed(3), note: 'register_payable (seller) + pay_ccd (sponsored). The buyer pays nothing but the invoice amount.' },
        per_new_payee: { nrg: perPayee, eur: +(perPayee * t.eur_per_nrg).toFixed(4), note: 'propose (seller) + accept (sponsored), once per binding.' },
        per_buyer_per_payee_version: { nrg: nrg('acknowledge_payee'), eur: +(nrg('acknowledge_payee') * t.eur_per_nrg).toFixed(4), note: 'acknowledge once; every later invoice to the same payee version reuses it.' },
        receipt_anchoring_per_day_max: { nrg: 4 * nrg('registerData receipt-head anchor (PVOH1)'), eur: +(4 * nrg('registerData receipt-head anchor (PVOH1)') * t.eur_per_nrg).toFixed(4), note: 'one 45-byte head every 6 h covers every receipt in between (urgent approval anchors extra, max 12/day).' },
      },
    };
  }
  return { rates, table };
}
