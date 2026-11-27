#!/usr/bin/env node
// PayOnce MCP server (stdio). Local, newline-delimited JSON-RPC on stdin/stdout.
//
//   PAYONCE_API_URL          default https://payonce-api-n98a.onrender.com
//   PAYONCE_MCP_ALLOW_PAY    "1" to offer pay_payable (otherwise read-only: list_payables, check_payable, receipt)
//
// This process holds NO key: payments go through the PayOnce API, which applies
// the vendor list, the mandate caps, the owner-consent gate and the co-signer
// before anything is signed. Testnet only.
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PayOnceClient } from '../src/client.mjs';
import { buildTools } from '../src/tools.mjs';
import { handleMcpMessage } from '../src/mcp-core.mjs';
import { envSecrets } from '../src/util.mjs';
import { localVerifierExec } from '../src/verifier-exec.mjs';

export function buildStdioServer(env = process.env, fetchImpl = fetch) {
  const baseUrl = env.PAYONCE_API_URL || 'https://payonce-api-n98a.onrender.com';
  const secrets = envSecrets(env);
  const client = new PayOnceClient({ baseUrl, fetchImpl, secrets });
  const canPay = env.PAYONCE_MCP_ALLOW_PAY === '1';
  const tools = buildTools({ client, canPay, exec: localVerifierExec({ apiBase: baseUrl }) });
  return { tools, secrets, client, canPay };
}

async function main() {
  const server = buildStdioServer();
  process.stderr.write(`payonce-mcp: stdio, api=${server.client.baseUrl}, tools=${server.tools.map((t) => t.name).join(',')}\n`);
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
    const res = await handleMcpMessage(msg, server);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
