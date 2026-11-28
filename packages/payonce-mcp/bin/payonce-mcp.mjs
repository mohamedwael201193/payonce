#!/usr/bin/env node
// payonce-mcp: stdio MCP server (newline-delimited JSON-RPC) that forwards every message to PayOnce's hosted
// Streamable-HTTP MCP endpoint. Read-only: the hosted endpoint never pays. Concordium testnet.
//   PAYONCE_MCP_URL  default https://payonce-api-n98a.onrender.com/mcp
import { createInterface } from 'node:readline';

export const DEFAULT_URL = 'https://payonce-api-n98a.onrender.com/mcp';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST one JSON-RPC message (or batch) to the hosted endpoint. Returns the parsed reply, or null for a 202. */
export async function forward(msg, { url = DEFAULT_URL, fetchImpl = fetch, retries = 2, timeoutMs = 90_000 } = {}) {
  const isReq = !Array.isArray(msg) && msg?.id !== undefined && msg?.id !== null;
  for (let attempt = 0; ; attempt += 1) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(msg), signal: ctrl.signal });
      if (res.status === 202) return null;
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      if ([429, 502, 503, 504].includes(res.status) && attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
      if (json) return json;
      return isReq ? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `PayOnce MCP answered HTTP ${res.status}` } } : null;
    } catch (e) {
      if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
      return isReq ? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `PayOnce MCP unreachable (${e?.name === 'AbortError' ? 'timeout' : e?.message})` } } : null;
    } finally { clearTimeout(timer); }
  }
}

export function serve({ input = process.stdin, output = process.stdout, url = process.env.PAYONCE_MCP_URL || DEFAULT_URL, fetchImpl } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  rl.on('line', (line) => {
    const t = line.trim(); if (!t) return;
    let msg; try { msg = JSON.parse(t); } catch { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); return; }
    const p = forward(msg, { url, fetchImpl }).then((r) => { if (r) output.write(`${JSON.stringify(r)}\n`); }).finally(() => pending.delete(p));
    pending.add(p);
  });
  return new Promise((resolve) => rl.on('close', async () => { await Promise.all([...pending]); resolve(); }));
}

if (process.argv[1] && /payonce-mcp(\.mjs)?$/.test(process.argv[1])) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('payonce-mcp: stdio MCP server for PayOnce Verification of Payee (Concordium testnet, read-only).\nTools: check_payee, check_x402_seller, get_payee_card, list_payables, check_payable, receipt.\nEnv: PAYONCE_MCP_URL (default ' + DEFAULT_URL + ')\n');
  } else { await serve(); }
}
