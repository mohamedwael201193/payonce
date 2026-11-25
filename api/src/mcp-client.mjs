// PayOnce API — hosted Agent Registry MCP client (workshops W2 §2.8, W6 §9.1;
// W-26). The registry's MCP server exposes 41 tools over Streamable HTTP
// (JSON-RPC); its HTTP badge-check endpoint was already used live, but the
// MCP tool protocol itself was not integrated into any PayOnce agent path.
// This module is that integration: at minimum `check_badge` (with
// `network: 'testnet'` passed explicitly on EVERY call — the server default
// is mainnet, so a missing network would leak mainnet data into a testnet
// check) plus `agent_of` / `agents_by_owner` lookups.
//
// Hygiene (W6 §9.1): the server is rate-limited per IP and SLOW (8–15 s
// per call observed 2026-11-25). Badge results are cached 60 s in-process
// and calls carry a 60 s timeout; callers must not hammer it. No mainnet
// call is ever made: every tool call asserts network === 'testnet' before
// sending, and the client throws rather than defaulting.
//
// The MCP speaks Streamable HTTP: POST JSON-RPC, `Accept: application/json,
// text/event-stream`, optional `mcp-session-id` header (the server returns
// none today, and works without one — the client tolerates both).
// Responses may arrive as a plain JSON-RPC body or as SSE `data:` lines;
// both are parsed. Tool results carry their payload as
// result.content[0].text (a JSON string).
import { CIS8004_OFFICIAL } from './config.mjs';

export const MCP_URL = 'https://agent-registry-mcp.concordium.com/mcp';
export const MCP_NETWORK = 'testnet';
export const MCP_TIMEOUT_MS = 60_000;
export const MCP_CACHE_TTL_MS = 60_000;
export const MCP_PROTOCOL_VERSION = '2025-03-26';

const cache = new Map(); // key -> { at, value }
export function clearMcpCache() {
  cache.clear();
}
function cacheGet(key, nowMs = Date.now()) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (nowMs - hit.at > MCP_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value, nowMs = Date.now()) {
  cache.set(key, { at: nowMs, value });
}

/** Parse a Streamable-HTTP MCP response body (plain JSON or SSE data: lines). */
export function parseMcpBody(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('mcp: empty response');
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  // SSE: one or more `data: {...}` lines; the last JSON-RPC message wins.
  let last = null;
  for (const line of trimmed.split('\n')) {
    const t = line.trim();
    if (t.startsWith('data:')) {
      const payload = t.slice(5).trim();
      if (payload && payload !== '[DONE]') last = JSON.parse(payload);
    }
  }
  if (!last) throw new Error('mcp: no JSON-RPC message in SSE response');
  return last;
}

/** Extract the tool-result payload: result.content[0].text (usually a JSON string). */
export function mcpToolText(message) {
  if (message?.error) throw new Error(`mcp: ${message.error.message ?? JSON.stringify(message.error)}`);
  const content = message?.result?.content;
  if (!Array.isArray(content) || content.length === 0) throw new Error('mcp: tool result has no content');
  const first = content[0];
  if (typeof first?.text !== 'string') throw new Error('mcp: tool result content is not text');
  if (message.result.isError) throw new Error(`mcp: tool error: ${first.text.slice(0, 300)}`);
  return first.text;
}

/** Parse tool text that is itself JSON; returns the raw text when it is not JSON. */
export function mcpToolJson(message) {
  const text = mcpToolText(message);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Assert the network is testnet — never let a call default to mainnet. */
export function assertTestnet(network) {
  if (network !== MCP_NETWORK) {
    throw new Error(`mcp: network must be '${MCP_NETWORK}' (got ${JSON.stringify(network)}); refusing to call the registry MCP without an explicit testnet network`);
  }
}

function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetchImpl(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/**
 * One JSON-RPC call against the hosted MCP. `sessionId` is sent when the
 * server issued one (it currently does not). Returns the parsed message.
 */
export async function mcpRpc({ method, params = {}, sessionId = null, fetchImpl = fetch, timeoutMs = MCP_TIMEOUT_MS }) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
    }, timeoutMs);
  } catch (e) {
    throw new Error(`mcp: ${method} failed to reach ${MCP_URL} (${e?.message ?? e})`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`mcp: ${method} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return { message: parseMcpBody(text), sessionId: res.headers?.get?.('mcp-session-id') ?? sessionId };
}

/** Initialize a session (tolerates the server returning no session id). */
export async function mcpInitialize({ fetchImpl = fetch, timeoutMs = MCP_TIMEOUT_MS } = {}) {
  const { message, sessionId } = await mcpRpc({
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'payonce-api', version: '1.0.0' },
    },
    fetchImpl,
    timeoutMs,
  });
  if (message?.error) throw new Error(`mcp: initialize failed: ${message.error.message ?? JSON.stringify(message.error)}`);
  return { sessionId: sessionId ?? null, server: message?.result?.serverInfo ?? null };
}

/** Call one MCP tool with the network asserted to testnet. */
export async function mcpCallTool({ name, arguments: args = {}, network = MCP_NETWORK, sessionId = null, fetchImpl = fetch, timeoutMs = MCP_TIMEOUT_MS }) {
  assertTestnet(network);
  const { message, sessionId: sid } = await mcpRpc({
    method: 'tools/call',
    params: { name, arguments: { ...args, network } },
    sessionId,
    fetchImpl,
    timeoutMs,
  });
  return { message, sessionId: sid ?? sessionId };
}

/** List the registry MCP tools (count + names). Cached 60 s. */
export async function mcpToolsList({ sessionId = null, fetchImpl = fetch, timeoutMs = MCP_TIMEOUT_MS } = {}) {
  const cached = cacheGet('tools/list');
  if (cached) return { ...cached, cached: true };
  const { message, sessionId: sid } = await mcpRpc({ method: 'tools/list', params: {}, sessionId, fetchImpl, timeoutMs });
  if (message?.error) throw new Error(`mcp: tools/list failed: ${message.error.message ?? JSON.stringify(message.error)}`);
  const tools = message?.result?.tools ?? [];
  const out = { count: tools.length, names: tools.map((t) => t.name), server: 'concordium-agent-registry-mcp' };
  cacheSet('tools/list', out);
  return { ...out, sessionId: sid ?? sessionId, cached: false };
}

/**
 * Badge check through the MCP tool protocol (not the HTTP endpoint).
 * `id` is the token address (badge id, e.g. JyP9XawpXHMjTN5ocrA5a).
 * Returns the parsed check_badge payload. Cached 60 s per badge.
 */
export async function mcpCheckBadge({ id, network = MCP_NETWORK, sessionId = null, fetchImpl = fetch, timeoutMs = MCP_TIMEOUT_MS } = {}) {
  assertTestnet(network);
  if (typeof id !== 'string' || !id) throw new Error('mcpCheckBadge: id (token address) is required');
  const key = `check_badge:${id}`;
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };
  const { message, sessionId: sid } = await mcpCallTool({ name: 'check_badge', arguments: { id }, network, sessionId, fetchImpl, timeoutMs });
  const payload = mcpToolJson(message);
  const out = { badge: id, network, via: 'mcp:check_badge', payload, sessionId: sid ?? sessionId };
  cacheSet(key, out);
  return { ...out, cached: false };
}

/** agent_of through the MCP tool protocol. */
export async function mcpAgentOf({ tokenId, network = MCP_NETWORK, sessionId = null, fetchImpl = fetch, timeoutMs = MCP_TIMEOUT_MS } = {}) {
  assertTestnet(network);
  if (!Number.isInteger(tokenId)) throw new Error('mcpAgentOf: tokenId must be an integer');
  const { message, sessionId: sid } = await mcpCallTool({ name: 'agent_of', arguments: { token_id: tokenId }, network, sessionId, fetchImpl, timeoutMs });
  return { tokenId, network, via: 'mcp:agent_of', payload: mcpToolJson(message), sessionId: sid ?? sessionId };
}

/** agents_by_owner through the MCP tool protocol. The tool's argument is
 * `owner_account` (not `owner`) — the MCP returns a config error otherwise. */
export async function mcpAgentsByOwner({ owner, network = MCP_NETWORK, sessionId = null, fetchImpl = fetch, timeoutMs = MCP_TIMEOUT_MS } = {}) {
  assertTestnet(network);
  if (typeof owner !== 'string' || !owner) throw new Error('mcpAgentsByOwner: owner account address is required');
  const { message, sessionId: sid } = await mcpCallTool({ name: 'agents_by_owner', arguments: { owner_account: owner, network }, network, sessionId, fetchImpl, timeoutMs });
  return { owner, network, via: 'mcp:agents_by_owner', payload: mcpToolJson(message), sessionId: sid ?? sessionId };
}

/** The official CIS-8004 registry this client always checks against. */
export const MCP_REGISTRY = { index: CIS8004_OFFICIAL.index, subindex: CIS8004_OFFICIAL.subindex };
