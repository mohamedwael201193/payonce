// registry-publish.mjs — publish PayOnce's agents on the OFFICIAL CIS-8004 Agent Registry <12802,0> (testnet).
//   PHASE=register  node api/scripts/registry-publish.mjs   mint the check_payee service agent (once; skips if minted)
//   PHASE=pin       node api/scripts/registry-publish.mjs   setAgentURI (card on our domain + SHA-256) and
//                   a deliberate setAgentWallet signed by the wallet's own key, for every agent in PLAN
//   PHASE=read      node api/scripts/registry-publish.mjs   read-only: wallets, nonces, EUDemo balances
// Payloads come from the official registry MCP (build_* tools, keyless). Every send is dry-run with
// invokeContract first, sent ONCE, and never resubmitted; an unknown outcome is recorded with its hash.
// Keys are derived in-process from the service env and never printed. Testnet only.
import { AccountAddress, ContractAddress, ReceiveName, Parameter, CcdAmount, Energy, Transaction, TransactionExpiry,
  Payload, TransactionHash } from '@concordium/web-sdk';
import { vClient } from '../src/consent.mjs';
import { signers } from '../src/chain-v2.mjs';
import { kvGet, kvPut } from '../src/store.mjs';
import { retryingReads } from '../src/node-retry.mjs';

const MCP = 'https://agent-registry-mcp.concordium.com/mcp';
const REG = { index: 12802n, subindex: 0n };
const SITE = 'https://payonce-tau.vercel.app/.well-known/registry';
const PHASE = process.env.PHASE ?? 'read';
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const c = retryingReads(vClient(), { tries: 8, maxMs: 15000 }); // reads only; sendTransaction is never retried
const S = await signers();
const byAddr = Object.fromEntries(Object.values(S).map((s) => [s.address, s.signer]));

let rpcId = 0;
async function mcp(name, args) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: { network: 'testnet', ...args } } }), signal: AbortSignal.timeout(30000) });
      const b = await r.json();
      if (b.error) throw new Error(`${name}: ${J(b.error)}`);
      const t = b.result?.content?.[0]?.text;
      if (b.result?.isError) throw new Error(`${name}: ${t}`);
      return JSON.parse(t);
    } catch (e) { if (i === 3) throw e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
}

const fin = async (h) => { const s = JSON.parse(J(await c.waitForTransactionFinalization(TransactionHash.fromHexString(h), 180_000))); return { hash: h, block: s.blockHash, outcome: s.summary?.transactionType === 'update' ? 'success' : 'reject', reject: s.summary?.rejectReason ?? null, cost_micro_ccd: s.summary?.cost, events_hex: JSON.stringify(s.summary).match(/"[0-9a-f]{20,}"/g)?.map((x) => x.slice(1, -1)) ?? [] }; };

/** Dry-run with invokeContract, then send once. Returns {dry, sent}. Never resends. */
async function call(sender, receiveName, paramHex, label) {
  const sAddr = AccountAddress.fromBase58(sender);
  const dry = await c.invokeContract({ invoker: sAddr, contract: ContractAddress.create(REG.index, REG.subindex), method: ReceiveName.fromString(receiveName), parameter: Parameter.fromHexString(paramHex), amount: CcdAmount.fromMicroCcd(0n) });
  if (dry.tag !== 'success') return { label, dry: 'would_reject', reason: J(dry.reason) };
  const used = BigInt(dry.usedEnergy?.value ?? dry.usedEnergy ?? 0);
  const info = await c.getAccountInfo(sAddr);
  const tx = Transaction.updateContract(Payload.updateContract({ amount: CcdAmount.fromMicroCcd(0n), address: ContractAddress.create(REG.index, REG.subindex), receiveName: ReceiveName.fromString(receiveName), message: Parameter.fromHexString(paramHex) }), Energy.create(used + used / 4n + 600n))
    .addMetadata({ sender: sAddr, nonce: info.accountNonce, expiry: TransactionExpiry.futureMinutes(8) }).build();
  const signed = await Transaction.signAndFinalize(tx, byAddr[sender]);
  let h;
  try { h = (await c.sendTransaction(signed)).toString(); } catch (e) {
    const out = { label, dry: 'ok', sent: 'unknown', error: String(e.message ?? e).slice(0, 300), note: 'status unknown; NOT resubmitted' };
    console.log('[send-unknown]', label); return out;
  }
  console.log(`[${label}] sent ${h}`);
  try { return { label, dry: 'ok', energy_dry: used, ...(await fin(h)) }; } catch (e) { return { label, dry: 'ok', hash: h, sent: 'unknown', error: String(e.message ?? e).slice(0, 200), note: 'not finalized in time; NOT resubmitted' }; }
}

const out = { phase: PHASE, at: new Date().toISOString(), registry: '<12802,0>' };
const prev = (await kvGet('registry_publish', 'state')) ?? {};

if (PHASE === 'register') {
  if (prev.check_payee_token != null) { out.skipped = `already minted: token ${prev.check_payee_token}`; }
  else {
    const b = await mcp('build_register', { sender: S.owner.address });
    const r = await call(S.owner.address, b.receive_name, b.parameter_hex, 'register check_payee agent');
    out.register = r;
    const ev = (r.events_hex ?? []).find((x) => x.startsWith('f008') && x.length >= 84);
    if (ev) {
      const tid = Buffer.from(ev.slice(4, 20), 'hex').readBigUInt64LE(0);
      out.check_payee_token = Number(tid);
      await kvPut('registry_publish', 'state', { ...prev, check_payee_token: Number(tid), register_tx: r.hash });
    }
  }
}

// PLAN: token -> card file (served on our domain) and the wallet that will sign its own binding.
const PLAN = JSON.parse(process.env.REG_PLAN ?? '[]'); // [{token, owner, wallet, file, sha256}]
if (PHASE === 'pin') {
  out.steps = [];
  for (const p of PLAN) {
    const uri = `${SITE}/${p.file}`;
    // 1) the served bytes must hash to what we pin — refuse otherwise.
    const body = Buffer.from(await (await fetch(uri, { cache: 'no-store' })).arrayBuffer());
    const { createHash } = await import('node:crypto');
    const served = createHash('sha256').update(body).digest('hex');
    if (served !== p.sha256) { out.steps.push({ token: p.token, skipped: `served sha ${served} != plan ${p.sha256}` }); continue; }
    const agent = await mcp('agent_of', { token_id: p.token });
    const cur = agent.agent ?? agent;
    if (cur.agent_uri === uri && (cur.metadata_hash_hex ?? cur.metadata_hash) === p.sha256) out.steps.push({ token: p.token, uri: 'already pinned' });
    else {
      const b = await mcp('build_set_agent_uri', { token_id: p.token, agent_uri: uri, metadata_hash_hex: p.sha256, sender: p.owner });
      out.steps.push({ token: p.token, step: 'setAgentURI', uri, sha256: p.sha256, ...(await call(p.owner, b.receive_name, b.parameter_hex, `setAgentURI ${p.token}`)) });
    }
    // 2) deliberate agentWallet binding, signed by the wallet's own key (skip if it already happened once).
    const n = await mcp('get_agent_wallet_nonce', { token_id: p.token });
    if (Number(n.wallet_set_nonce) > 0) { out.steps.push({ token: p.token, wallet: `already bound (nonce ${n.wallet_set_nonce})` }); continue; }
    const deadline = Date.now() + 10 * 60_000;
    const cb = await mcp('set_agent_wallet_canonical_bytes', { token_id: p.token, new_wallet: p.wallet, deadline_unix_ms: deadline });
    const bytes = Buffer.from(cb.bytes_hex, 'hex');
    // Check the layout ourselves before signing: prefix, token id, owner, wallet.
    const okLayout = bytes.length === 162 && bytes.subarray(0, 26).toString() === 'CIS-8004/v1/setAgentWallet' && bytes.readBigUInt64LE(26) === BigInt(p.token)
      && Buffer.from(AccountAddress.fromBase58(p.owner).decodedAddress).equals(bytes.subarray(34, 66)) && Buffer.from(AccountAddress.fromBase58(p.wallet).decodedAddress).equals(bytes.subarray(66, 98));
    if (!okLayout) { out.steps.push({ token: p.token, skipped: 'canonical bytes layout mismatch' }); continue; }
    const sig = (await byAddr[p.wallet].sign(bytes))[0][0];
    const b = await mcp('build_set_agent_wallet', { token_id: p.token, new_wallet: p.wallet, deadline_unix_ms: deadline, signature_hex: sig, sender: p.owner });
    await kvPut('registry_publish', 'pin_latest', out);
    out.steps.push({ token: p.token, step: 'setAgentWallet', wallet: p.wallet, nonce_before: 0, ...(await call(p.owner, b.receive_name, b.parameter_hex, `setAgentWallet ${p.token}`)) });
  }
  await kvPut('registry_publish', 'pin_latest', out);
}

// Always: read-only state (wallets, nonces, EUDemo).
out.read = {};
for (const a of [S.owner.address, S.sellerB.address, S.seller2.address]) {
  const i = JSON.parse(J(await c.getAccountInfo(AccountAddress.fromBase58(a))));
  out.read[a] = { ccd_micro: String(i.accountAmount?.microCcdAmount ?? i.accountAmount), tokens: (i.accountTokens ?? []).map((t) => ({ id: t.id?.value ?? t.id, state: t.state })) };
}
console.log('RESULT', J(out));
process.exit(0);
