// PayOnce API — buyer agent + merchant-side badge check (workshops W2 §2.9;
// W-23, W-52 step 4). One direction was live: the pay flow verifies the
// SELLER agent before paying (verifier-v2 agentCheck, token 1476 Active on
// <12802,0>). The missing direction is the merchant side: the store's agent
// verifies the BUYER agent's badge before fulfilling. That needs a buyer
// agent to exist first — only the seller was registered — so this module
// does both halves:
//
//   1. registerBuyerAgent: mint a CIS-8004 token for the buyer (payer B,
//      4MvdMEGC…) from the payer's own in-process signer, same
//      all-absent-params shape as the lab's spike registration
//      (CIS-8004.register, parameter 00000000000000, 30000 NRG). The token
//      id comes from the on-chain Registered event, cross-checked against
//      the MCP agents_by_owner list for the payer.
//   2. merchantCheckBuyer: the fulfilment gate. The merchant agent checks
//      the buyer token via the MCP tool protocol (agent_of + is_active —
//      the buyer agent carries no card yet, so the 15-check badge (which
//      requires a card + URI) is NOT the gate here; the gate is Active +
//      owner == the payer account). An unknown/revoked token, or a token
//      owned by someone else, is refused fulfilment. The check is recorded
//      with its evidence; a refusal names the failing check.
//
// Testnet only. The buyer agent is a demo agent of the lab's own payer
// account, disclosed as such — it is the second independent agent using
// the layer (W-58), not an external merchant (no external merchant exists;
// see the fix-back report).
import { AccountAddress, Transaction, TransactionExpiry, ContractAddress, ReceiveName, Parameter, CcdAmount, Energy, SequenceNumber } from '@concordium/web-sdk';
import { CIS8004_OFFICIAL, PAYER_ADDRESS, txUrl } from './config.mjs';
import { agentOf, getAccount, microCcdOf, nextNonce, waitFinalized } from './chain-v2.mjs';
import { mcpAgentOf, mcpAgentsByOwner, mcpCheckBadge } from './mcp-client.mjs';
import { loadBuyerAgent, saveBuyerAgent } from './store.mjs';

export const BUYER_ACCOUNT = PAYER_ADDRESS;
export const CIS8004_REGISTER_PARAM_HEX = '00000000000000';
export const CIS8004_REGISTER_ENERGY = 30000n;

/** Parse a CIS-8004 Registered event's token id (0x08 tag + u64 LE). */
export function parseRegisteredTokenId(events) {
  for (const e of events ?? []) {
    const data = typeof e?.data === 'string' ? e.data : (e?.event?.data ?? '');
    if (!data) continue;
    const hex = data.toLowerCase();
    // CIS-8004 event encoding: 0x08 (AgentTokenId) + u64 LE token id.
    const idx = hex.indexOf('08');
    if (idx >= 0 && hex.length >= idx + 2 + 16) {
      const le = Buffer.from(hex.slice(idx + 2, idx + 2 + 16), 'hex');
      const id = Number(le.readBigUInt64LE(0));
      if (id > 0) return id;
    }
  }
  return null;
}

/**
 * Register the buyer agent on the official CIS-8004 registry from the
 * payer's own signer. Returns { tokenId, txHash, explorerUrl, ccdSpent }.
 * Refuses when a buyer token is already recorded (registration is once).
 */
export async function registerBuyerAgent({ grpcClient, signers }) {
  const existing = await loadBuyerAgent();
  if (existing?.tokenId) {
    throw new Error(`registerBuyerAgent: buyer agent already registered (token ${existing.tokenId}, tx ${existing.txHash})`);
  }
  const { sellerB } = await signers();
  const sender = AccountAddress.fromBase58(BUYER_ACCOUNT);
  // NOTE: never call grpcClient.getAccountInfo with this file's
  // AccountAddress — the client is the backend's web-sdk copy and the
  // class-identity check rejects the api copy's instances ("Unsupported
  // account identifier"). String-address helpers (getAccount / nextNonce)
  // and the backend's waitFinalized are the safe boundary.
  const ccdBefore = Number(microCcdOf((await getAccount(grpcClient, BUYER_ACCOUNT))?.accountAmount)) / 1e6;
  // Send with a fresh nonce each attempt: concurrent live runs send from
  // the same payer account, so a nonce read can go stale between the read
  // and the send. The node rejects a duplicate nonce BEFORE acceptance,
  // so retrying with a fresh nonce cannot double-send.
  let txHash = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3 && !txHash; attempt++) {
    try {
      const nonce = await nextNonce(grpcClient, BUYER_ACCOUNT);
      const tx = Transaction.updateContract({
        amount: CcdAmount.fromMicroCcd(0n),
        address: ContractAddress.create(BigInt(CIS8004_OFFICIAL.index), BigInt(CIS8004_OFFICIAL.subindex)),
        receiveName: ReceiveName.fromString('CIS-8004.register'),
        message: Parameter.fromBuffer(Buffer.from(CIS8004_REGISTER_PARAM_HEX, 'hex')),
      }, Energy.create(CIS8004_REGISTER_ENERGY)).addMetadata({
        sender,
        nonce: SequenceNumber.create(nonce),
        expiry: TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
      });
      const finalized = await Transaction.signAndFinalize(tx.build(), sellerB.signer);
      const hash = await grpcClient.sendTransaction(finalized);
      txHash = (typeof hash === 'string' ? hash : Buffer.from(hash.buffer ?? hash).toString('hex')).toLowerCase();
    } catch (e) {
      lastErr = e;
      if (!/duplicate nonce/i.test(String(e?.message ?? e)) || attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!txHash) throw lastErr ?? new Error('registerBuyerAgent: send failed');
  // Poll for finalization (up to 120 s, backend helper).
  // waitFinalized returns getTxStatus: { status, blockHash, summary } —
  // events live at status.summary.events (NOT status.outcome.summary).
  const status = await waitFinalized(grpcClient, txHash);
  const events = status.summary?.events ?? status.outcome?.summary?.events ?? [];
  let tokenId = parseRegisteredTokenId(events);
  if (!tokenId) {
    // Cross-check via the MCP: the payer's tokens, newest first.
    const owned = await mcpAgentsByOwner({ owner: BUYER_ACCOUNT });
    const list = owned?.payload?.agents ?? owned?.payload?.tokens ?? owned?.payload ?? [];
    const ids = (Array.isArray(list) ? list : []).map((a) => Number(a.token_id ?? a.tokenId ?? a.id)).filter((n) => Number.isInteger(n) && n > 0);
    tokenId = ids.length ? Math.max(...ids) : null;
  }
  if (!tokenId) throw new Error(`registerBuyerAgent: finalized ${txHash} but no token id could be read (event + MCP lookup both empty)`);
  const ccdAfter = Number(microCcdOf((await getAccount(grpcClient, BUYER_ACCOUNT))?.accountAmount)) / 1e6;
  const record = {
    account: BUYER_ACCOUNT,
    tokenId,
    txHash,
    explorerUrl: txUrl(txHash),
    registeredAt: new Date().toISOString(),
    ccdSpent: (ccdBefore - ccdAfter).toFixed(6),
    role: 'buyer agent (demo payer account, lab)',
  };
  await saveBuyerAgent(record);
  return record;
}

/**
 * The merchant-side gate: verify a buyer token before fulfilment.
 * Checks (via MCP tool protocol + a direct agentOf read):
 *   - token exists on <12802,0> (agent_of)
 *   - status Active (is_active via agent_of status)
 *   - owner == the expected payer account
 * The full 15-check badge is attempted when the token has a token
 * address with a card; without a card the card checks are reported as
 * not_run (honest: no card exists yet), never faked as passing.
 * Returns { verdict: 'pass'|'refuse', tokenId, checks, evidence }.
 */
export async function merchantCheckBuyer({ grpcClient, tokenId, expectedOwner = BUYER_ACCOUNT, fetchImpl = fetch }) {
  const checks = [];
  const push = (id, label, status, detail) => checks.push({ id, label, status, detail });
  if (!Number.isInteger(tokenId) || tokenId < 1) {
    push('token', 'Buyer token id is a positive integer', 'fail', `tokenId=${JSON.stringify(tokenId)}`);
    return { verdict: 'refuse', tokenId, expectedOwner, checks, evidence: { via: 'merchantCheckBuyer' } };
  }
  let agent = null;
  try {
    agent = await agentOf(grpcClient, tokenId);
  } catch (e) {
    push('exists', 'Buyer agent exists on the official CIS-8004 registry', 'fail', `agentOf read failed: ${String(e?.message ?? e).slice(0, 200)}`);
    return { verdict: 'refuse', tokenId, expectedOwner, checks, evidence: { via: 'merchantCheckBuyer' } };
  }
  if (!agent) {
    push('exists', 'Buyer agent exists on the official CIS-8004 registry', 'fail', `agentOf(${tokenId}) returned nothing on <${CIS8004_OFFICIAL.index},${CIS8004_OFFICIAL.subindex}>`);
    return { verdict: 'refuse', tokenId, expectedOwner, checks, evidence: { via: 'merchantCheckBuyer' } };
  }
  push('exists', 'Buyer agent exists on the official CIS-8004 registry', 'ok', `token ${tokenId} on <${CIS8004_OFFICIAL.index},${CIS8004_OFFICIAL.subindex}>, owner=${agent.owner?.slice(0, 8) ?? '?'}…`);
  const activeOk = agent.statusName === 'Active';
  push('active', 'Buyer agent status is Active (not revoked)', activeOk ? 'ok' : 'fail', `status=${agent.statusName}`);
  const ownerOk = agent.owner === expectedOwner;
  push('owner', 'Buyer agent owner is the expected payer account', ownerOk ? 'ok' : 'fail', `owner=${agent.owner}, expected=${expectedOwner}`);
  // MCP leg: agent_of through the tool protocol (same facts, second path).
  let mcpAgent = null;
  let mcpError = null;
  try {
    const res = await mcpAgentOf({ tokenId, fetchImpl });
    mcpAgent = res.payload;
  } catch (e) {
    mcpError = String(e?.message ?? e).slice(0, 200);
  }
  if (mcpAgent && typeof mcpAgent === 'object') {
    const mcpOwnerOk = mcpAgent.owner_account === expectedOwner;
    const mcpActiveOk = mcpAgent.status === 'Active';
    push('mcp_agent_of', 'MCP agent_of agrees (owner + Active)', mcpOwnerOk && mcpActiveOk ? 'ok' : 'fail', `mcp owner=${mcpAgent.owner_account?.slice(0, 8) ?? '?'}…, status=${mcpAgent.status}, token_address=${mcpAgent.token_address ?? 'none'}`);
  } else {
    push('mcp_agent_of', 'MCP agent_of agrees (owner + Active)', 'not_run', `MCP call failed: ${mcpError ?? 'no payload'}`);
  }
  // Full badge check only when the agent has a published card/URI.
  // Every CIS-8004 token gets a token_address, but the badge checks
  // fetch a CARD — with no agent_uri there is no card to check, so the
  // check is not_run (never faked, never a fail): Active + owner is the
  // gate for a card-less buyer agent, stated plainly.
  const tokenAddress = mcpAgent?.token_address ?? null;
  const agentUri = mcpAgent?.agent_uri ?? null;
  let badge = null;
  if (tokenAddress && agentUri) {
    try {
      const res = await mcpCheckBadge({ id: tokenAddress, fetchImpl });
      badge = res.payload;
      const badgeValid = badge?.badge_valid === true;
      push('badge', 'Full badge check passes (15 checks, card + URI)', badgeValid ? 'ok' : 'fail', badgeValid ? 'badge_valid:true' : `badge_valid:${badge?.badge_valid ?? 'unknown'}`);
    } catch (e) {
      push('badge', 'Full badge check passes (15 checks, card + URI)', 'not_run', `MCP check_badge failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  } else {
    push('badge', 'Full badge check passes (15 checks, card + URI)', 'not_run', 'buyer agent has no published card/URI yet, so the card checks cannot run — Active + owner is the gate, stated plainly');
  }
  const failed = checks.filter((c) => c.status === 'fail');
  return {
    verdict: failed.length === 0 ? 'pass' : 'refuse',
    tokenId,
    expectedOwner,
    checks,
    evidence: {
      via: 'merchantCheckBuyer (MCP agent_of + direct agentOf)',
      tokenAddress,
      registry: `<${CIS8004_OFFICIAL.index},${CIS8004_OFFICIAL.subindex}>`,
      badge: badge ? { token_id: badge.token_id ?? tokenId, badge_valid: badge.badge_valid ?? null } : null,
    },
  };
}

/** Load the recorded buyer agent, or null. */
export async function buyerAgent() {
  return loadBuyerAgent();
}
