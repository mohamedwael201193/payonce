// A fake PayOnce API (fetch implementation) for the agent unit tests. No network.
import { sha256Hex } from '../src/util.mjs';

export const S1 = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
export const S2 = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr';
export const PAYER = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';
export const PAYEE = '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin';

export function docFor(id, extra = '', seller = S1) {
  return `PAYONCE LAB INVOICE — payable ${id} (CCD)\nSeller: ${seller}\nPayee: ${PAYEE}\nAmount: 0.500000 CCD (500000 microCCD)\n${extra}Test only.\n`;
}

/**
 * state.payables: Map "seller:id" -> { id, seller, asset, amount, doc, status }
 * Options: buyerVerdict ('pass'|'refuse'), ageProof (bool), consent ('not_required'|'required'|'approved'), badgeValid.
 */
export function makeFakeApi(opts = {}) {
  const state = { calls: [], payables: new Map(), jobs: new Map(), paid: [], ageProofOnFile: new Set(), ...opts.state };
  const o = { buyerVerdict: 'pass', badgeValid: true, vendors: [S1, S2], ...opts };
  const add = (p) => state.payables.set(`${p.seller}:${p.id}`, { asset: 'CCD', amount: '500000', status: 'unpaid', ...p, doc: p.doc ?? docFor(p.id, p.docExtra ?? '', p.seller) });
  for (const p of opts.payables ?? []) add(p);

  const json = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ method, path: u.pathname, body });
    const seller = u.searchParams.get('seller') ?? body?.seller ?? S1;
    let m;
    if (u.pathname === '/api/config') {
      return json(200, {
        registry: { index: 13150, subindex: 0 },
        vendor_list: o.vendors.map((s) => ({ seller: s, label: 'v' })),
        sellers: [{ seller: S1, label: 'Seller 1', agent_token: 1476, badge: 'B1' }, { seller: S2, label: 'Seller 2', agent_token: 1506, badge: 'B2' }],
        buyer_agent: { account: PAYER, token_id: 1488 },
      });
    }
    if (u.pathname === '/api/invoices') {
      const items = [...state.payables.values()].map((p) => ({ payable_id: p.id, seller: p.seller, asset: p.asset.toLowerCase(), amount_display: '0.5 CCD', due: 'x', status: p.status === 'paid' ? 'Paid' : 'Unpaid', kind: 'demo' }));
      return json(200, { items, rows_scanned: items.length, complete: true });
    }
    if ((m = /^\/api\/mcp\/badge\/(\d+)$/.exec(u.pathname))) {
      const owner = Number(m[1]) === 1476 ? S1 : S2;
      return json(200, { payload: { token_id: Number(m[1]), badge_valid: o.badgeValid, issues: o.badgeValid ? [] : [{ message: 'bad' }], on_chain: { status: 'Active', owner_account: owner } } });
    }
    if ((m = /^\/api\/payables\/(\d+)$/.exec(u.pathname))) {
      const p = state.payables.get(`${seller}:${Number(m[1])}`);
      if (!p) return json(404, { error: { code: 'not_found', layer: 'server', message: 'no payable' } });
      return json(200, { payable_id: p.id, seller: p.seller, asset: { token: p.asset }, amount: p.amount, amount_display: '0.500000 CCD', payee: PAYEE, due: 'd', status: { kind: p.status }, agent: { token: 1476 }, doc_sha256: sha256Hex(p.doc) });
    }
    if ((m = /^\/api\/payables\/(\d+)\/document$/.exec(u.pathname))) {
      const p = state.payables.get(`${seller}:${Number(m[1])}`);
      return p ? json(200, p.doc) : json(404, { error: { code: 'not_found', layer: 'server', message: 'no doc' } });
    }
    if ((m = /^\/api\/payables\/(\d+)\/gates$/.exec(u.pathname))) {
      const id = Number(m[1]);
      const p = state.payables.get(`${seller}:${id}`);
      const ageReq = /^Age restriction: 18\+/m.test(p?.doc ?? '') || BigInt(p?.amount ?? 0) >= 1_000_000n;
      return json(200, {
        consent: { status: o.consent ?? (BigInt(p?.amount ?? 0) >= 1_000_000n ? 'required' : 'not_required') },
        age_gate: { required: ageReq, reason: ageReq ? 'test' : null, proof_on_file: state.ageProofOnFile.has(id) },
        buyer_agent: { verdict: o.buyerVerdict, tokenId: 1488, checks: o.buyerVerdict === 'pass' ? [{ id: 'agent_wallet', status: 'ok', detail: 'x' }] : [{ id: 'agent_wallet', status: 'fail', detail: 'agentWallet mismatch' }] },
      });
    }
    if ((m = /^\/api\/payables\/(\d+)\/verify$/.exec(u.pathname))) {
      return json(200, { verdict: o.verifyVerdict ?? 'ready', passed: 6, total: 9, checks: [] });
    }
    if ((m = /^\/api\/payables\/(\d+)\/pay$/.exec(u.pathname))) {
      const id = Number(m[1]);
      const p = state.payables.get(`${seller}:${id}`);
      if (/^Age restriction: 18\+/m.test(p.doc) && !state.ageProofOnFile.has(id)) return json(409, { error: { code: 'age_proof_required', layer: 'app', message: 'age proof required' } });
      const jobId = `job_${id}`;
      p.status = 'paid';
      state.paid.push({ seller, id, rail: body.rail, doc_sha256: body.doc_sha256 });
      state.jobs.set(jobId, { job_id: jobId, state: 'succeeded', outcome: 'paid', steps: [{ step: 'submit', status: 'ok', detail: 'sent', txHash: 'a'.repeat(64), explorerUrl: 'https://x/tx' }] });
      return json(200, { job_id: jobId, steps: ['submit'] });
    }
    if ((m = /^\/api\/jobs\/([^/]+)$/.exec(u.pathname))) return json(200, state.jobs.get(m[1]));
    if ((m = /^\/api\/payables\/(\d+)\/receipt$/.exec(u.pathname))) {
      const p = state.payables.get(`${seller}:${Number(m[1])}`);
      if (!p || p.status !== 'paid') return json(404, { error: { code: 'not_found', layer: 'server', message: 'no receipt' } });
      return json(200, { payable_id: p.id, seller: p.seller, amount_display: '0.5 CCD', payee: PAYEE, txs: [{ label: 'Payment', tx_hash: 'a'.repeat(64) }], verifier: { passed: 10, total: 10 }, art12: { anchor_tx: 'b'.repeat(64), record_hash: 'c'.repeat(64), task: 't' } });
    }
    return json(404, { error: { code: 'not_found', layer: 'server', message: `no route ${u.pathname}` } });
  };
  return { fetchImpl, state, add };
}
