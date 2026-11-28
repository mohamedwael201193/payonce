// A2A (Agent2Agent) JSON-RPC 2.0 endpoint for PayOnce check_payee: POST /a2a
//   message/send  { message: { role:'user', parts:[ {kind:'data', data:{payee, name, network?}} | {kind:'text', text:'...invoice text...'} ] } }
//   -> a Message from the agent with a text part (what an agent may do) and a data part (the full check result).
// Free and read-only; nothing is paid or signed here. A text part is read with the invoice parser (a CLAIM from text,
// never an instruction); the check decides. Methods that need tasks or streaming say so plainly (the card says streaming:false).
import { randomUUID } from 'node:crypto';
import { parseInvoice } from './invoice-parse.mjs';

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{50}$/;
const ERR = { parse: -32700, invalid: -32600, method: -32601, params: -32602, internal: -32603, taskNotFound: -32001, notCancelable: -32002, unsupported: -32004 };
const ADVICE = {
  MATCH: 'Match: pay once, to this account only.',
  CLOSE_MATCH: 'Close match: stop and ask the person. Pay only if they confirm.',
  NO_MATCH: 'No match: pay nothing.',
  UNVERIFIED: 'Verification not possible: stop and ask the person. This is not a match.',
};
const OUTCOME = { MATCH: 'match', CLOSE_MATCH: 'close_match', NO_MATCH: 'no_match', UNVERIFIED: 'not_possible' };

const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const agentMessage = (parts, contextId) => ({ kind: 'message', role: 'agent', messageId: randomUUID(), ...(contextId ? { contextId } : {}), parts });

/** Pull {payee, name, network} out of the message parts. Data parts win; text goes through the invoice parser. */
export function inputFromMessage(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const out = {};
  for (const p of parts) {
    if (p?.kind === 'data' && p.data && typeof p.data === 'object') {
      out.payee ??= p.data.payee ?? p.data.account ?? p.data.pay_to;
      out.name ??= p.data.name ?? p.data.legal_name;
      out.network ??= p.data.network;
    }
  }
  const text = parts.filter((p) => p?.kind === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
  if (text && (!out.payee || !out.name)) {
    try { const inv = parseInvoice(text); out.payee ??= inv.account ?? undefined; out.name ??= inv.payee_name ?? undefined; out.warnings = inv.warnings; } catch { /* no usable text */ }
  }
  return out;
}

export function createA2A({ check }) {
  async function send(params, id) {
    const message = params?.message;
    if (!message || message.role !== 'user' || !Array.isArray(message.parts)) return rpcErr(id, ERR.params, 'params.message with role "user" and parts is required.');
    const input = inputFromMessage(message);
    if (!input.payee || !input.name || !ADDR.test(String(input.payee))) {
      return { jsonrpc: '2.0', id, result: agentMessage([{ kind: 'text', text: 'I need two things: the Concordium account that would be paid, and the name the invoice or instruction gave for the payee. Send a data part like {"payee":"<account>","name":"Acme ApS"} or paste the invoice text. I check and never pay.' }], message.contextId) };
    }
    const network = String(input.network ?? '').toLowerCase() === 'mainnet' ? 'mainnet' : undefined;
    const r = await check({ payee: input.payee, seller: input.payee, legal_name: String(input.name).slice(0, 200), network });
    const verdict = r.verdict;
    const text = `${verdict}: ${ADVICE[verdict] ?? 'Unknown verdict: pay nothing.'}${r.reasons?.[0] ? ` (${r.reasons[0]})` : ''}${input.warnings?.length ? ` Note: ${input.warnings[0]}` : ''}`;
    const data = { ...r, epc_verdict: String(verdict).toLowerCase(), outcome: OUTCOME[verdict] ?? 'not_possible', payee: input.payee, name: input.name };
    return { jsonrpc: '2.0', id, result: agentMessage([{ kind: 'text', text }, { kind: 'data', data }], message.contextId) };
  }

  /** body: parsed JSON (object or batch array). Returns the JSON-RPC response (or array), never throws. */
  async function handle(body) {
    if (Array.isArray(body)) return Promise.all(body.map((b) => handle(b)));
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return rpcErr(body?.id, ERR.invalid, 'Not a JSON-RPC 2.0 request.');
    const { id, method, params } = body;
    try {
      if (method === 'message/send') return await send(params, id);
      if (method === 'message/stream' || method === 'tasks/resubscribe') return rpcErr(id, ERR.unsupported, 'Streaming is not supported (the card says streaming:false). Use message/send.');
      if (method === 'tasks/get') return rpcErr(id, ERR.taskNotFound, 'PayOnce answers in one message and keeps no tasks.');
      if (method === 'tasks/cancel') return rpcErr(id, ERR.taskNotFound, 'PayOnce answers in one message and keeps no tasks.');
      return rpcErr(id, ERR.method, `Unknown method ${method.slice(0, 60)}. Supported: message/send.`);
    } catch (e) {
      if (e?.status && e.status < 500) return rpcErr(id, ERR.params, String(e.message ?? e).slice(0, 300));
      return rpcErr(id, ERR.internal, `The check could not run (${String(e?.message ?? e).slice(0, 200)}). Nothing was paid.`);
    }
  }
  return { handle };
}
