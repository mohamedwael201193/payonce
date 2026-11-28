// PayOnce API - wiring of the open-seller flow and the ecosystem verifier into the live server.
// Real adapters (gRPC, the official registry MCP, the payer's signer) live here; the decisions live in
// open-sellers.mjs and ecosystem-verify.mjs, which are unit-tested with stubs.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AccountAddress, ModuleReference, getEmbeddedModuleSchema, getUpdateContractParameterSchema,
  serializeTypeValue, verifyMessageSignature, ContractName, EntrypointName, versionedModuleSourceFromBuffer, tokenAddressToBase58, ContractAddress,
} from '@concordium/web-sdk';
import { createOpenSellers, OpenError, isAddress } from './open-sellers.mjs';
import { payableVerdict } from './ecosystem-verify.mjs';
import { kvGet, kvPut, kvPutIfAbsent, kvList, kvDelete, hitWindow as storeHitWindow } from './store.mjs';
import {
  grpc, getPayableOrNull, getVendor, agentOf as chainAgentOf, sendUpdate, waitFinalized, signers, chainNow,
  getTx, getBlockTime, getRegistryBalance,
} from './chain-v2.mjs';
import { backend } from './backend.mjs';
import { mcpCallTool, mcpToolJson, mcpCheckBadge, mcpAgentOf } from './mcp-client.mjs';
import {
  REGISTRY, CIS8004_OFFICIAL, PAYER_ADDRESS, PAYEE_CCD, PAYEE_EUDEMO, OWNER_ADDRESS, SELLER2_ADDRESS, EXPLORER_TX, PORT, ENV,
} from './config.mjs';

export const API_PUBLIC_BASE = (ENV.PAYONCE_PUBLIC_API_BASE ?? 'https://payonce-api-n98a.onrender.com').replace(/\/$/, '');
const hex = (b) => Buffer.from(b).toString('hex');

// ---- schemas the wallet needs to serialize parameters ----
let registrySchemaB64 = null;
export async function initSchemas() {
  try {
    const p = fileURLToPath(new URL(`../../contracts/${REGISTRY.name}/${REGISTRY.name}.wasm.v1`, import.meta.url));
    if (!existsSync(p)) return null;
    const src = versionedModuleSourceFromBuffer(readFileSync(p));
    const schema = await getEmbeddedModuleSchema(src);
    if (!schema) return null;
    const param = getUpdateContractParameterSchema(Buffer.from(schema.buffer), ContractName.fromString(REGISTRY.name), EntrypointName.fromString('register_payable'), schema.version);
    registrySchemaB64 = Buffer.from(param).toString('base64');
    return registrySchemaB64;
  } catch (e) {
    console.error('[open] register_payable schema unavailable:', e?.message ?? e);
    return null;
  }
}

const cisSchemaCache = new Map();
async function cis8004ParamSchema(entrypoint) {
  if (cisSchemaCache.has(entrypoint)) return cisSchemaCache.get(entrypoint);
  const c = await grpc();
  const src = await c.getModuleSource(ModuleReference.fromHexString(CIS8004_OFFICIAL.moduleRef));
  const schema = await getEmbeddedModuleSchema(src);
  if (!schema) throw new Error('the CIS-8004 module has no embedded schema');
  const b64 = Buffer.from(getUpdateContractParameterSchema(Buffer.from(schema.buffer), ContractName.fromString('CIS-8004'), EntrypointName.fromString(entrypoint), schema.version)).toString('base64');
  cisSchemaCache.set(entrypoint, b64);
  return b64;
}

/** Fail closed: the JSON the wallet will serialize must produce exactly the bytes the registry tool built. */
export function assertSerializesTo(parameterJson, schemaB64, expectedHex) {
  const got = hex(serializeTypeValue(parameterJson, Buffer.from(schemaB64, 'base64')).buffer);
  if (got !== String(expectedHex).toLowerCase()) throw new OpenError(502, 'schema_mismatch', 'The wallet parameter would not serialize to the bytes the registry tool built. Nothing to sign.');
  return true;
}

async function mcpJson(name, args) {
  const { message } = await mcpCallTool({ name, arguments: args });
  if (message?.result?.isError) throw new OpenError(502, 'registry_mcp_error', `Agent Registry MCP ${name}: ${String(message.result.content?.[0]?.text ?? '').slice(0, 300)}`);
  return mcpToolJson(message);
}

export const registryMcp = {
  agentsByOwner: (owner) => mcpJson('agents_by_owner', { owner_account: owner }),
  buildAgentCard: (args) => mcpJson('build_agent_card', args),
  async buildRegister(args) {
    const out = await mcpJson('build_register', args);
    try { assertSerializesTo(out.parameter_json, await cis8004ParamSchema('register'), out.parameter_hex); } catch (e) { if (e instanceof OpenError) throw e; }
    return out;
  },
  async buildSetAgentUri(args) {
    const out = await mcpJson('build_set_agent_uri', args);
    try { assertSerializesTo(out.parameter_json, await cis8004ParamSchema('setAgentURI'), out.parameter_hex); } catch (e) { if (e instanceof OpenError) throw e; }
    return out;
  },
  async checkBadge(tokenAddress) { return (await mcpCheckBadge({ id: tokenAddress })).payload; },
  tokenAddress: (tokenId) => tokenAddressToBase58({ contract: ContractAddress.create(CIS8004_OFFICIAL.index, CIS8004_OFFICIAL.subindex), id: Buffer.from(new BigUint64Array([BigInt(tokenId)]).buffer).toString('hex') }),
};

async function agentWith(tokenId) {
  const c = await grpc();
  const a = await chainAgentOf(c, tokenId);
  if (!a) return null;
  let agentWallet = null;
  try { agentWallet = (await mcpAgentOf({ tokenId: Number(tokenId) })).payload?.agent_wallet ?? null; } catch { agentWallet = null; }
  return { owner: a.owner, status: a.statusName, agentWallet };
}

export const chainAdapter = {
  async getPayable(seller, id) { return getPayableOrNull(await grpc(), seller, id); },
  async getVendor(buyer, seller) { return getVendor(await grpc(), buyer, seller); },
  agentOf: agentWith,
  async verifySignature(account, message, signature) {
    const c = await grpc();
    const info = await c.getAccountInfo(AccountAddress.fromBase58(account));
    return verifyMessageSignature(message, signature, info);
  },
  async approveVendor(seller, { tier, perCap, periodCap, periodSecs }) {
    const c = await grpc();
    const { v2enc } = await backend();
    const { rejectOf } = await import('./jobs.mjs');
    const sig = await signers();
    const sent = await sendUpdate(c, { from: sig.sellerB, receiveName: 'approve_vendor', parameterHex: v2enc.encodeV2ApproveVendor({ seller, tier, perCap, periodCap, periodSecs }), maxEnergy: 6000n });
    const status = await waitFinalized(c, sent.txHash);
    const rr = rejectOf(status);
    return { txHash: sent.txHash, outcome: rr ? 'rejected' : 'success', reject: rr ? JSON.stringify(rr.rejectReason).slice(0, 160) : null };
  },
};

// ---- the buyer agent paying one open invoice (same tools as /mcp and the agent) ----
async function payWithAgent({ seller, id, docText, expectedAmount }) {
  const { PayOnceClient } = await import('../../agent/src/client.mjs');
  const { buildTools } = await import('../../agent/src/tools.mjs');
  const { envSecrets } = await import('../../agent/src/util.mjs');
  const client = new PayOnceClient({ baseUrl: `http://127.0.0.1:${PORT}`, headers: { 'x-forwarded-for': 'payonce-open-agent' }, secrets: envSecrets(ENV), timeoutMs: 120_000 });
  const tools = buildTools({ client, canPay: true });
  const check = tools.find((t) => t.name === 'check_payable');
  const pay = tools.find((t) => t.name === 'pay_payable');
  const verdict = await check.handler({ seller, id, doc_text: docText, expected_amount: String(expectedAmount) });
  if (verdict.verdict !== 'pay') return { paid: false, refused: true, verdict: verdict.verdict, reasons: verdict.reasons, checks: verdict.checks, nothing_sent: true };
  const out = await pay.handler({ seller, id, doc_text: docText, expected_amount: String(expectedAmount) });
  return { ...out, checks: verdict.checks };
}

let refreshRow = async () => {};
export function setOpenRowRefresher(fn) { refreshRow = fn; }

export const open = createOpenSellers({
  kv: { get: kvGet, put: kvPut, putIfAbsent: kvPutIfAbsent, list: kvList, delete: kvDelete },
  chain: chainAdapter,
  mcp: registryMcp,
  payer: PAYER_ADDRESS,
  registry: REGISTRY,
  apiPublicBase: API_PUBLIC_BASE,
  explorerTx: EXPLORER_TX,
  hitWindow: storeHitWindow,
  internalAccounts: [PAYER_ADDRESS, PAYEE_CCD, PAYEE_EUDEMO],
  get registerPayableSchemaB64() { return registrySchemaB64 || null; },
  cis8004Schemas: (ep) => cis8004ParamSchema(ep).catch(() => null),
  payWithAgent,
  onInvoiceRecorded: (seller, id) => refreshRow(seller, id),
});

// ---- ecosystem verifier (any seller) ----
export async function verifyAnyPayable({ seller, id, docSha256 = null, buyer = null, tx = null }) {
  const c = await grpc();
  const view = await getPayableOrNull(c, seller, id);
  if (!view) return payableVerdict({ view: null });
  const [agent, nowInfo] = await Promise.all([agentWith(view.agentToken).catch(() => null), chainNow(c)]);
  let badge = null;
  try { badge = await registryMcp.checkBadge(registryMcp.tokenAddress(Number(view.agentToken))); } catch { badge = null; }
  let vendor = null;
  if (buyer) { try { vendor = await getVendor(c, buyer, seller); } catch { vendor = null; } }
  let receiptChecks = null;
  const payTx = tx ?? view.record?.txHash ?? null;
  if (view.status === 'Paid' && payTx && view.asset === 'CCD') {
    try {
      const { verifyCcdV2 } = await import('./verifier-v2.mjs');
      const summary = await getTx(c, payTx);
      const blockTime = await getBlockTime(c, summary.blockHash);
      const balance = await getRegistryBalance(c);
      const r = await verifyCcdV2(c, { payableId: id, txHash: payTx, summary, blockTime, view, balance, docSha256 });
      receiptChecks = r.checks.filter((x) => ['tx_finalized', 'invoked_pay_ccd', 'sender_is_payer', 'single_transfer_to_payee', 'no_other_transfer'].includes(x.id))
        .map((x) => ({ id: `receipt_${x.id}`, label: `Payment tx: ${x.label}`, status: x.status, detail: x.detail }));
    } catch (e) {
      receiptChecks = [{ id: 'receipt', label: 'Payment transaction re-verified', status: 'warn', detail: `could not read the payment tx (${String(e?.message ?? e).slice(0, 120)})` }];
    }
  }
  const out = payableVerdict({ view, agent, badge, vendor, buyer, docSha256, chainNowMs: nowInfo.slotMs, receiptChecks });
  return {
    network: 'testnet', registry: `<${REGISTRY.index},${REGISTRY.subindex}>`, ...out,
    payment_tx: payTx, explorer_url: payTx ? `${EXPLORER_TX}${payTx}` : null,
    seller_badge: registryMcp.tokenAddress(Number(view.agentToken)),
    checked_at: new Date().toISOString(),
  };
}

// ---- routes ----
export function openRoutes({ sendJson, apiError, readBody, clientIp, hitWindow }) {
  const wrap = (fn) => async (req, res, m) => {
    try {
      return sendJson(res, 200, await fn(req, res, m));
    } catch (e) {
      if (e instanceof OpenError) return apiError(res, e.status, e.code, 'app', e.message, e.extra);
      if (/body too large|invalid JSON/.test(e?.message ?? '')) return apiError(res, 400, 'bad_request', 'app', e.message);
      return apiError(res, 502, 'open_upstream', 'node', `The chain or the registry service did not answer (${String(e?.message ?? e).slice(0, 200)}).`, { retryable: true });
    }
  };
  const limited = (key, perMin) => async (req) => {
    const w = await hitWindow(`${key}:${clientIp(req)}`, 60_000, perMin);
    if (!w.allowed) throw new OpenError(429, 'rate_limited', 'Too many requests, slow down.', { retryable: true, retry_after_s: Math.ceil(w.resetMs / 1000) });
  };
  const q = (req, k) => new URL(req.url, 'http://x').searchParams.get(k);
  return [
    ['GET', /^\/api\/open\/config$/, wrap(() => open.config())],
    ['GET', /^\/api\/open\/sellers$/, wrap(async () => { await open.load(); return { sellers: open.allListed().map((s) => ({ account: s.account, agent_token: s.agent_token, badge: s.badge, listed_at: s.listed_at, listing_tx: s.listing_tx, invoices: (s.invoices ?? []).length })) }; })],
    ['GET', /^\/api\/open\/sellers\/([1-9A-HJ-NP-Za-km-z]{50})$/, wrap(async (req, res, m) => { await limited('open:status', 30)(req); return open.status(m[1]); })],
    ['POST', /^\/api\/open\/agent-card$/, wrap(async (req) => { await limited('open:card', 6)(req); return open.startAgent(await readBody(req)); })],
    ['POST', /^\/api\/open\/agent-card\/finalize$/, wrap(async (req) => { await limited('open:card', 6)(req); return open.finishAgent(await readBody(req)); })],
    ['GET', /^\/cards\/([1-9A-HJ-NP-Za-km-z]{50})\/(\d+)\.json$/, async (req, res, m) => {
      const body = await open.card(m[1], m[2]);
      if (!body) return apiError(res, 404, 'no_card', 'app', 'No such agent card.');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
      return res.end(body);
    }],
    ['POST', /^\/api\/open\/sellers\/challenge$/, wrap(async (req) => { await limited('open:challenge', 10)(req); return open.challenge(await readBody(req)); })],
    ['POST', /^\/api\/open\/sellers\/list$/, wrap(async (req) => { await limited('open:list', 4)(req); return open.list(await readBody(req), { ip: clientIp(req) }); })],
    ['POST', /^\/api\/open\/invoices\/draft$/, wrap(async (req) => { await limited('open:draft', 10)(req); return open.draftInvoice(await readBody(req)); })],
    ['POST', /^\/api\/open\/invoices$/, wrap(async (req) => { await limited('open:record', 10)(req); return open.recordInvoice(await readBody(req)); })],
    ['POST', /^\/api\/open\/invoices\/([1-9A-HJ-NP-Za-km-z]{50})\/(\d+)\/agent-pay$/, wrap(async (req, res, m) => open.agentPay({ seller: m[1], id: Number(m[2]) }, { ip: clientIp(req) }))],
    ['GET', /^\/api\/verify\/payable$/, wrap(async (req) => {
      await limited('verify', 30)(req);
      const seller = q(req, 'seller'); const id = Number(q(req, 'id'));
      if (!isAddress(seller) || !Number.isInteger(id) || id < 0) throw new OpenError(400, 'bad_request', 'verify needs ?seller=<account>&id=<payable id> (optional doc_sha256, buyer, tx).');
      const docSha256 = q(req, 'doc_sha256'); const buyer = q(req, 'buyer'); const tx = q(req, 'tx');
      if (docSha256 && !/^[0-9a-fA-F]{64}$/.test(docSha256)) throw new OpenError(400, 'bad_request', 'doc_sha256 must be 64 hex characters.');
      if (buyer && !isAddress(buyer)) throw new OpenError(400, 'bad_request', 'buyer must be an account address.');
      if (tx && !/^[0-9a-fA-F]{64}$/.test(tx)) throw new OpenError(400, 'bad_request', 'tx must be a 64-hex transaction hash.');
      return verifyAnyPayable({ seller, id, docSha256, buyer, tx: tx ? tx.toLowerCase() : null });
    })],
  ];
}

export const KNOWN_SELLERS = [OWNER_ADDRESS, SELLER2_ADDRESS];
