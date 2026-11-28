// payonce-check-payee: a thin, dependency-free client for PayOnce's Verification of Payee API (Concordium testnet).
// It never signs and never pays. It tells an agent what it may do with a payee.
export const DEFAULT_API = 'https://payonce-api-n98a.onrender.com';

/** The four outcomes, derived from the raw verdict (never from server advice). */
export const OUTCOMES = Object.freeze({
  MATCH: { outcome: 'match', action: 'pay', exit: 0, text: 'Match: pay once, to this account only.' },
  CLOSE_MATCH: { outcome: 'close_match', action: 'ask_human', exit: 2, text: 'Close match: stop and ask a person. Pay only if they confirm.' },
  NO_MATCH: { outcome: 'no_match', action: 'refuse', exit: 1, text: 'No match: pay nothing.' },
  UNVERIFIED: { outcome: 'not_possible', action: 'ask_human', exit: 3, text: 'Verification not possible: stop and ask a person. This is not a match.' },
});
export const decide = (verdict) => OUTCOMES[String(verdict ?? '').toUpperCase()] ?? OUTCOMES.UNVERIFIED;

export class CheckPayeeError extends Error {
  constructor(message, { status = null, code = null } = {}) { super(message); this.name = 'CheckPayeeError'; this.status = status; this.code = code; }
}

async function getJson(url, { fetchImpl = fetch, timeoutMs = 60_000, retries = 2, method = 'GET', body } = {}) {
  // Reads are safe to repeat (the free Render tier can take ~30 s to wake up).
  for (let attempt = 0; ; attempt += 1) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      if (res.ok) return json ?? {};
      if ([429, 502, 503, 504].includes(res.status) && attempt < retries) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw new CheckPayeeError(json?.error?.message ?? json?.message ?? `HTTP ${res.status}`, { status: res.status, code: json?.error?.code ?? null });
    } catch (e) {
      if (e instanceof CheckPayeeError) throw e;
      if (attempt < retries) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw new CheckPayeeError(`network: ${e?.name === 'AbortError' ? 'timeout' : (e?.message ?? e)}`);
    } finally { clearTimeout(timer); }
  }
}

const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

/** check_payee: who is this account, and does it match the name you were given?
 *  network 'testnet' (default): full check. 'mainnet': read-only identity check, never MATCH, nothing is payable from it. */
export async function checkPayee({ payee, name, seller, country, network, api = DEFAULT_API, ...opts }) {
  if (network != null && !['testnet', 'mainnet'].includes(String(network).toLowerCase())) throw new CheckPayeeError('network must be testnet or mainnet');
  if (!payee) throw new CheckPayeeError('payee (a Concordium account address) is required');
  if (!name) throw new CheckPayeeError('name (the payee name on the invoice or instruction) is required');
  const r = await getJson(`${api}/api/check-payee?${qs({ payee, seller: seller ?? payee, legal_name: name, country, network: String(network ?? '').toLowerCase() === 'mainnet' ? 'mainnet' : undefined })}`, opts);
  return { ...r, ...decide(r.verdict), verdict: r.verdict };
}

/** Read an x402 seller's 402 without paying, then check its payTo. Nothing is sent. */
export async function probeX402({ url, name, method = 'GET', body, api = DEFAULT_API, ...opts }) {
  if (!url) throw new CheckPayeeError('url of the paid resource is required');
  if (!name) throw new CheckPayeeError('name (who you meant to pay) is required');
  const r = await getJson(`${api}/api/x402/probe`, { ...opts, method: 'POST', body: { url, name, method, body } });
  const d = r.decision ?? {};
  const verdict = r.check?.verdict ?? null;
  const o = d.outcome ? Object.values(OUTCOMES).find((x) => x.outcome === d.outcome) ?? decide(verdict) : decide(verdict);
  return { ...r, ...o, verdict };
}

/** The public payee card for an account. */
export async function payeeCard(account, { api = DEFAULT_API, ...opts } = {}) {
  if (!account) throw new CheckPayeeError('account is required');
  return getJson(`${api}/api/p/${encodeURIComponent(account)}`, opts);
}
