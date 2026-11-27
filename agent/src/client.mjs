// HTTP client for the PayOnce API. Every tool, the MCP server and the agent go
// through this one class, so there is one place that retries, bounds time and
// wraps errors. Errors carry the API's own typed envelope and nothing else:
// no stack, no request headers, no tokens.
import { redact, sleep } from './util.mjs';

export class ApiError extends Error {
  constructor(status, body, path) {
    const e = body?.error ?? {};
    super(`${e.code ?? 'http_' + status}: ${redact(e.message ?? `HTTP ${status} on ${path}`)}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = e.code ?? `http_${status}`;
    this.layer = e.layer ?? 'server';
    this.retryable = Boolean(e.retryable);
    this.envelope = e;
    this.path = path;
  }
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);

export class PayOnceClient {
  /**
   * @param {object} o
   * @param {string} o.baseUrl     e.g. https://payonce-api-n98a.onrender.com or http://127.0.0.1:7401
   * @param {Function} [o.fetchImpl]
   * @param {string[]} [o.secrets] exact values to redact from any error text
   * @param {number} [o.timeoutMs]
   * @param {number[]} [o.backoffMs] delays between retries on 429/5xx
   * @param {Record<string,string>} [o.headers] extra headers (e.g. x-payonce-run)
   */
  constructor({ baseUrl, fetchImpl = fetch, secrets = [], timeoutMs = 60_000, backoffMs = [1000, 2000, 4000], headers = {} }) {
    if (!baseUrl) throw new Error('PayOnceClient: baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.secrets = secrets;
    this.timeoutMs = timeoutMs;
    this.backoffMs = backoffMs;
    this.headers = headers;
    this._cfg = null;
  }

  async request(method, path, { body, allow = [] } = {}) {
    let attempt = 0;
    for (;;) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res;
      let text;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...this.headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
        text = await res.text();
      } catch (e) {
        clearTimeout(timer);
        if (attempt < this.backoffMs.length) { await sleep(this.backoffMs[attempt++]); continue; }
        throw new Error(`network: ${method} ${path} did not answer (${redact(e?.name === 'AbortError' ? 'timeout' : e?.message, this.secrets)})`);
      }
      clearTimeout(timer);
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (res.ok) return { status: res.status, body: json ?? text };
      if (allow.includes(res.status)) return { status: res.status, body: json ?? text };
      if (RETRY_STATUS.has(res.status) && attempt < this.backoffMs.length) {
        const wait = this.backoffMs[attempt];
        attempt += 1;
        await sleep(wait);
        continue;
      }
      throw new ApiError(res.status, json, path);
    }
  }

  sellerQ(seller) { return seller ? `?seller=${encodeURIComponent(seller)}` : ''; }

  async config({ fresh = false } = {}) {
    if (!this._cfg || fresh || Date.now() - this._cfg.at > 60_000) this._cfg = { at: Date.now(), body: (await this.request('GET', '/api/config')).body };
    return this._cfg.body;
  }
  async health() { return (await this.request('GET', '/api/health')).body; }
  async invoices() { return (await this.request('GET', '/api/invoices')).body; }
  async payable(seller, id) {
    const r = await this.request('GET', `/api/payables/${id}${this.sellerQ(seller)}`, { allow: [404] });
    return r.status === 404 ? null : r.body;
  }
  async documentText(seller, id) {
    const r = await this.request('GET', `/api/payables/${id}/document${this.sellerQ(seller)}`, { allow: [404] });
    return r.status === 404 ? null : (typeof r.body === 'string' ? r.body : null);
  }
  async verify(seller, id, mode = 'before_pay') {
    return (await this.request('POST', `/api/payables/${id}/verify${this.sellerQ(seller)}`, { body: { mode } })).body;
  }
  async gates(seller, id) { return (await this.request('GET', `/api/payables/${id}/gates${this.sellerQ(seller)}`)).body; }
  async badge(idOrAddress) { return (await this.request('GET', `/api/mcp/badge/${encodeURIComponent(idOrAddress)}`)).body; }
  async createPayable({ seller, asset, ageGate }) {
    return (await this.request('POST', `/api/payables${this.sellerQ(seller)}`, { body: { asset, seller, ...(ageGate ? { age_gate: ageGate } : {}) } })).body;
  }
  async pay(seller, id, { rail, docSha256 }) {
    return (await this.request('POST', `/api/payables/${id}/pay${this.sellerQ(seller)}`, { body: { rail, seller, ...(docSha256 ? { doc_sha256: docSha256 } : {}) } })).body;
  }
  async job(jobId) { return (await this.request('GET', `/api/jobs/${encodeURIComponent(jobId)}`)).body; }
  async receipt(seller, id) {
    const r = await this.request('GET', `/api/payables/${id}/receipt${this.sellerQ(seller)}`, { allow: [404] });
    return r.status === 404 ? null : r.body;
  }
  async ageProofVerify({ request, payableId, payer }) {
    return this.request('POST', '/api/age-proof/verify', { body: { request, payable_id: payableId, payer }, allow: [400, 403, 503] });
  }
  /** V&A V1 age proof for one payable: the API anchors the request, the scoped prover answers, the proof is filed for the payer. */
  async ageProofV1({ payableId }) {
    return this.request('POST', '/api/age-proof/v1', { body: { payable_id: payableId }, allow: [400, 403, 503] });
  }
  async ageProofHealth() { return (await this.request('GET', '/api/age-proof/health')).body; }

  /** Poll a pay job until it ends. Returns the final job snapshot. */
  async waitJob(jobId, { timeoutMs = 240_000, pollMs = 3000, onStep } = {}) {
    const end = Date.now() + timeoutMs;
    let seen = 0;
    for (;;) {
      const j = await this.job(jobId);
      const steps = j.steps ?? [];
      if (onStep) for (; seen < steps.length; seen += 1) onStep(steps[seen]);
      if ((j.state && j.state !== 'running') || j.finished_at) return j;
      if (Date.now() > end) return { ...j, status: 'timeout' };
      await sleep(pollMs);
    }
  }
}
