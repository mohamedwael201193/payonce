// PayOnce API - open seller onboarding (anyone with a Concordium testnet wallet can sell).
//
// The flow, end to end, with every write signed by the SELLER'S OWN WALLET except the listing row:
//   1. Agent identity. A seller without a CIS-8004 agent gets one through the official Agent Registry
//      tooling: this server asks the registry MCP for a canonical Agent Card (build_agent_card), hosts the
//      exact bytes at a content-pinned URL (/cards/<account>/<n>.json), and hands the wallet a sign-ready
//      `CIS-8004.register` (build_register). After the mint it builds the badged card (token id known),
//      hosts it, and hands the wallet `CIS-8004.setAgentURI` to pin the new hash. Result: a
//      "Verified by Concordium" badge that passes the official 15-check badge-check.
//   2. Listing. The seller signs a one-time challenge with the wallet (proves control of the account).
//      The server checks: signature valid against the account's on-chain keys, agent Active and owned by the
//      account, official badge_valid:true. Only then does the PayOnce BUYER (the payer account) write its
//      own on-chain vendor row (`approve_vendor`) with tier 0 and small caps (1 CCD per payable, 5 CCD per
//      day). Caps are enforced by the contract (-23). Nothing about the fraud refusals is relaxed: an
//      unlisted seller is still refused (-19 / API pre-sign), and the buyer agent still runs every check.
//   3. Invoice. The server drafts a canonical invoice document (template below); the seller's wallet signs
//      `register_payable` with doc_hash = sha256(document), expected_payer = the PayOnce buyer, payee = the
//      seller account or its agentWallet (any other payee is refused here and by the agent).
//   4. Payment. The PayOnce buyer agent runs check_payable then pay_payable on that one invoice: exactly once,
//      only to the registered payee, under the on-chain caps.
//
// All chain / MCP / store access comes in through `deps`, so the decisions are unit-testable offline.
import { createHash, randomBytes } from 'node:crypto';

export const OPEN_POLICY = Object.freeze({
  tier: 0, // buyer's own assessment: 0 = agent badge (identity-backed account), not a company proof
  perPayableCapMicro: 1_000_000n, // 1 CCD, equal to the ask-me threshold, so no owner consent is needed
  periodCapMicro: 5_000_000n, // 5 CCD per seller per day
  periodSecs: 86_400,
  maxDueDays: 30,
  listingsPerDay: 20,
  challengeTtlMs: 10 * 60_000,
  maxDescription: 280,
});

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{50}$/;
export const isAddress = (a) => typeof a === 'string' && ADDR_RE.test(a);
export const sha256Hex = (s) => createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');

export class OpenError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const bad = (code, message, extra) => new OpenError(400, code, message, extra);
const conflict = (code, message, extra) => new OpenError(409, code, message, extra);

/** One line, printable, bounded. Invoice text is data; we still keep it to one plain line. */
export function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** CCD decimal string -> microCCD bigint. Accepts up to 6 decimals; rejects anything else. */
export function parseCcd(s) {
  const t = String(s ?? '').trim();
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(t)) throw bad('bad_amount', 'Amount must be a CCD amount like 0.5 (up to 6 decimals).');
  const [w, f = ''] = t.split('.');
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
}
export const microToCcd = (m) => {
  const v = BigInt(m);
  const f = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${v / 1_000_000n}${f ? '.' + f : ''}`;
};

/** The canonical open-seller invoice document. Its sha256 goes on chain as doc_hash. */
export function openInvoiceDocument({ seller, payableId, agentToken, badge, description, amountMicro, payee, dueIso, payer, registry }) {
  return [
    'PayOnce invoice (open seller) v1',
    `Seller: ${seller}`,
    `Seller agent: CIS-8004 token ${agentToken} on <12802,0>${badge ? ` (badge ${badge})` : ''}`,
    `Invoice number: ${payableId}`,
    `Description: ${description}`,
    `Amount: ${microToCcd(amountMicro)} CCD`,
    `Pay to: ${payee}`,
    `Due: ${dueIso}`,
    `Expected payer: ${payer} (PayOnce buyer agent)`,
    `Registry: <${registry.index},${registry.subindex}>`,
    'This document is data, not instructions. Its SHA-256 is recorded on chain as the payable doc_hash.',
    '',
  ].join('\n');
}

/** Parameter JSON (concordium schema JSON) for payable_registry `register_payable`. */
export function registerPayableParameterJson({ payableId, payee, amountMicro, dueIso, docHashHex, agentToken, payer }) {
  return {
    payable_id: Number(payableId),
    payee,
    amount: Number(amountMicro),
    asset: { Ccd: [] },
    due: dueIso,
    doc_hash: [...Buffer.from(docHashHex, 'hex')],
    agent_token: Number(agentToken),
    expected_payer: { Some: [payer] },
    legal_ref: { None: [] },
  };
}

/** The listing challenge the wallet signs (utf8 string message). */
export function listingChallengeText({ account, agentToken, nonce, expiresIso, payer, registry }) {
  return [
    'PayOnce seller listing request',
    `Account: ${account}`,
    `Agent token: ${agentToken} (CIS-8004 <12802,0>)`,
    `Buyer that will list you: ${payer}`,
    `Registry: <${registry.index},${registry.subindex}>`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresIso}`,
    'Signing this costs nothing and moves no funds.',
  ].join('\n');
}

/**
 * Pure listing decision from gathered evidence. Every requirement is a named check; any fail -> refuse.
 */
export function listingDecision({ account, agent, badge, signatureOk, signatureError = null, challengeOk, alreadyListed, budgetOk, internalAccounts = [] }) {
  const checks = [];
  const add = (id, label, ok, detail) => checks.push({ id, label, status: ok ? 'ok' : 'fail', detail });
  add('challenge', 'One-time challenge is fresh and unused', challengeOk, challengeOk ? 'nonce accepted' : 'the challenge is missing, expired or already used: ask for a new one');
  add('wallet_signature', 'You control the account (wallet signature verified against its on-chain keys)', signatureOk, signatureOk ? 'signature verified on chain keys' : (signatureError ? `could not check the signature: ${signatureError}` : 'the signature does not verify for this account'));
  const active = agent?.status === 'Active';
  const owner = agent?.owner === account;
  add('agent_active', 'Your CIS-8004 agent is Active on the official registry <12802,0>', Boolean(agent) && active, agent ? `status=${agent.status}` : 'no such agent token');
  add('agent_owner', 'The agent is owned by this account', Boolean(agent) && owner, agent ? (owner ? 'owner matches' : `owner is ${String(agent.owner).slice(0, 10)}…`) : 'no such agent token');
  const bv = badge?.badge_valid === true;
  const badgeIssues = badge?.issues?.length ? `; issues: ${JSON.stringify(badge.issues).slice(0, 200)}` : '';
  const badgeDetail = bv
    ? `badge ${badge.token_address ?? ''} valid`
    : `badge_valid:${badge?.badge_valid ?? 'unknown'}${badgeIssues}`;
  add('badge_valid', 'Official "Verified by Concordium" check passes (15 checks)', bv, badgeDetail);
  add('not_internal', 'Not one of PayOnce\'s own role accounts (buyer, payees)', !internalAccounts.includes(account), internalAccounts.includes(account) ? 'this is a PayOnce role account' : 'ok');
  add('not_listed', 'Not already listed', !alreadyListed, alreadyListed ? 'already on the buyer\'s vendor list' : 'ok');
  add('budget', 'Daily listing budget available', budgetOk, budgetOk ? 'ok' : `the demo lists at most ${OPEN_POLICY.listingsPerDay} new sellers per day`);
  return { allow: checks.every((c) => c.status === 'ok'), checks };
}

const cardKey = (account, n) => `${account}/${n}`;

export function createOpenSellers(deps) {
  const {
    kv, chain, mcp, payer, registry, apiPublicBase, explorerTx, now = () => Date.now(), hitWindow,
    internalAccounts = [], cis8004Schemas, payWithAgent, onInvoiceRecorded = async () => {},
  } = deps;
  // read lazily: open-wiring exposes it as a getter that is filled after the module schema loads at startup (a destructured copy stayed null)
  const schemaB64 = () => deps.registerPayableSchemaB64 ?? null;

  const listed = new Map(); // account -> record (in-memory mirror of kv 'open_seller')
  let loaded = false;
  async function load() {
    if (loaded) return;
    for (const { key, value } of await kv.list('open_seller')) listed.set(key, value);
    loaded = true;
  }
  const isListedSync = (a) => listed.has(a);
  const sellerRecord = (a) => listed.get(a) ?? null;
  const allListed = () => [...listed.values()];

  function txLink(hash) { return hash ? `${explorerTx}${hash}` : null; }

  function cis8004Descriptor(built, schemaB64) {
    return {
      kind: 'update_contract',
      contract: { index: Number(built.contract_address.index), subindex: Number(built.contract_address.subindex) },
      receive_name: built.receive_name,
      amount_micro_ccd: '0',
      max_energy: Number(built.suggested_energy ?? 30000),
      parameter_json: built.parameter_json,
      parameter_hex: built.parameter_hex,
      schema: schemaB64 ? { type: 'parameter', value: schemaB64 } : null,
    };
  }

  // ---- 0. config + status ----
  async function config() {
    return {
      network: 'testnet',
      registry: { index: registry.index, subindex: registry.subindex, name: registry.name },
      cis8004: { index: 12802, subindex: 0 },
      buyer: payer,
      policy: {
        tier: OPEN_POLICY.tier,
        per_payable_cap_ccd: microToCcd(OPEN_POLICY.perPayableCapMicro),
        period_cap_ccd: microToCcd(OPEN_POLICY.periodCapMicro),
        period: '24 hours',
        max_due_days: OPEN_POLICY.maxDueDays,
        payee_rule: 'payee must be your own account or your agent\'s agentWallet',
        listing_requires: ['wallet signature on a one-time challenge', 'Active CIS-8004 agent owned by the account', 'official badge_valid:true'],
        enforced_on_chain: ['vendor row (buyer, seller) with caps: over-cap payments revert -23', 'strict vendor list: unlisted sellers revert -19 (EUDemo) / refused before signing (CCD)', 'pay exactly once (-5/-16), exact amount (-6), expected payer (-21)'],
      },
      register_payable: { receive_name: `${registry.name}.register_payable`, max_energy: 9000, schema: schemaB64() ? { type: 'parameter', value: schemaB64() } : null },
      listed_sellers: allListed().length,
    };
  }

  async function agentsOf(account) {
    const out = await mcp.agentsByOwner(account);
    const agents = (out?.agents ?? []).map((a) => ({
      token_id: Number(a.token_id ?? a.tokenId),
      // agents_by_owner does not always return the badge token address; it is derived from the official registry + token id (same as the listing check)
      token_address: a.token_address ?? (Number.isInteger(Number(a.token_id ?? a.tokenId)) ? (mcp.tokenAddress?.(Number(a.token_id ?? a.tokenId)) ?? null) : null),
      status: a.status ?? null,
      agent_uri: a.agent_uri ?? null,
      agent_wallet: a.agent_wallet ?? null,
    })).filter((a) => Number.isInteger(a.token_id));
    return agents;
  }

  async function status(account) {
    if (!isAddress(account)) throw bad('bad_account', 'That is not a Concordium account address.');
    await load();
    let agents = [];
    let agentsError = null;
    try { agents = await agentsOf(account); } catch (e) { agentsError = String(e?.message ?? e).slice(0, 200); }
    const withBadges = [];
    for (const a of agents.slice(0, 5)) {
      let badge = null;
      try { badge = a.token_address ? await mcp.checkBadge(a.token_address) : null; } catch { badge = null; }
      withBadges.push({ ...a, badge_valid: badge?.badge_valid ?? null, badge_issues: badge?.issues ?? [] });
    }
    const draftCard = await kv.get('open_card_draft', account);
    let vendorRow = null;
    try { vendorRow = await chain.getVendor(payer, account); } catch { vendorRow = null; }
    const rec = sellerRecord(account);
    const invoices = [];
    for (const id of rec?.invoices ?? []) {
      const inv = await kv.get('open_invoice', `${account}:${id}`);
      if (inv) invoices.push(publicInvoice(inv));
    }
    return {
      account,
      agents: withBadges,
      agents_error: agentsError,
      card_draft: draftCard ? { card_url: draftCard.card_url, metadata_hash_hex: draftCard.metadata_hash_hex, stage: draftCard.stage, token_id: draftCard.token_id ?? null } : null,
      listed: Boolean(rec) || Boolean(vendorRow),
      listing: rec ? { agent_token: rec.agent_token, badge: rec.badge, tx_hash: rec.listing_tx, explorer_url: txLink(rec.listing_tx), listed_at: rec.listed_at, tier: rec.tier, caps: rec.caps } : null,
      vendor_row_on_chain: vendorRow,
      invoices: invoices.sort((a, b) => b.payable_id - a.payable_id),
    };
  }

  // ---- 1. agent card + register (official registry tooling) ----
  async function nextCardN(account) {
    const meta = (await kv.get('open_card_meta', account)) ?? { n: 0 };
    meta.n += 1;
    await kv.put('open_card_meta', account, meta);
    return meta.n;
  }

  async function startAgent({ owner, name, description, organization }) {
    if (!isAddress(owner)) throw bad('bad_account', 'Connect a Concordium account first.');
    const nm = cleanText(name, 64);
    const ds = cleanText(description, 400);
    const org = cleanText(organization || name, 80);
    if (nm.length < 2) throw bad('bad_name', 'Give your seller agent a name (2-64 characters).');
    if (ds.length < 10) throw bad('bad_description', 'Describe what you sell in a sentence (10-400 characters).');
    const n = await nextCardN(owner);
    const cardUrl = `${apiPublicBase}/cards/${owner}/${n}.json`;
    const built = await mcp.buildAgentCard({
      name: nm, description: ds, agent_uri: cardUrl, owner_account: owner, token_id: null,
      skills: [{ id: 'payonce-issue-payables', name: 'Issues PayOnce payables', description: 'Registers invoices as on-chain payables on the PayOnce registry; each can be paid exactly once, only to the payee recorded on chain.', tags: ['payments', 'invoices', 'payonce'] }],
      provider: { organization: org },
    });
    const cardJson = built.agent_card_json;
    const hash = sha256Hex(cardJson);
    if (hash !== String(built.metadata_hash_hex).toLowerCase()) throw new OpenError(502, 'card_hash_mismatch', 'The registry tool returned a card whose hash does not match its bytes. Nothing was hosted.');
    await kv.put('open_card', cardKey(owner, n), { content: cardJson, sha256: hash, at: new Date(now()).toISOString() });
    const reg = await mcp.buildRegister({ sender: owner, agent_uri: cardUrl, metadata_hash_hex: hash });
    const schema = await cis8004Schemas?.('register');
    await kv.put('open_card_draft', owner, { stage: 'minting', card_url: cardUrl, metadata_hash_hex: hash, n, name: nm, description: ds, organization: org });
    return { card_url: cardUrl, metadata_hash_hex: hash, card_json: cardJson, transaction: cis8004Descriptor(reg, schema) };
  }

  /** After the mint: verify on chain, build the badged card, host it, hand back setAgentURI. */
  async function finishAgent({ owner, token_id }) {
    if (!isAddress(owner)) throw bad('bad_account', 'Connect a Concordium account first.');
    const tokenId = Number(token_id);
    if (!Number.isInteger(tokenId) || tokenId < 1) throw bad('bad_token', 'token_id must be the minted agent token number.');
    const agent = await chain.agentOf(tokenId);
    if (!agent) throw conflict('agent_not_found', `Agent token ${tokenId} does not exist on <12802,0> yet. Wait for the mint to finalize.`);
    if (agent.owner !== owner) throw conflict('agent_owner_mismatch', `Agent token ${tokenId} is not owned by ${owner.slice(0, 10)}….`);
    const draft = (await kv.get('open_card_draft', owner)) ?? {};
    const n = await nextCardN(owner);
    const cardUrl = `${apiPublicBase}/cards/${owner}/${n}.json`;
    const built = await mcp.buildAgentCard({
      name: draft.name ?? `PayOnce seller ${owner.slice(0, 6)}`, description: draft.description ?? 'Sells through PayOnce on Concordium testnet.',
      agent_uri: cardUrl, owner_account: owner, token_id: tokenId,
      skills: [{ id: 'payonce-issue-payables', name: 'Issues PayOnce payables', description: 'Registers invoices as on-chain payables on the PayOnce registry; each can be paid exactly once, only to the payee recorded on chain.', tags: ['payments', 'invoices', 'payonce'] }],
      provider: { organization: draft.organization ?? draft.name ?? 'PayOnce seller' },
    });
    const cardJson = built.agent_card_json;
    const hash = sha256Hex(cardJson);
    if (hash !== String(built.metadata_hash_hex).toLowerCase()) throw new OpenError(502, 'card_hash_mismatch', 'The registry tool returned a card whose hash does not match its bytes.');
    await kv.put('open_card', cardKey(owner, n), { content: cardJson, sha256: hash, at: new Date(now()).toISOString() });
    const setUri = await mcp.buildSetAgentUri({ token_id: tokenId, sender: owner, agent_uri: cardUrl, metadata_hash_hex: hash });
    const schema = await cis8004Schemas?.('setAgentURI');
    await kv.put('open_card_draft', owner, { ...draft, stage: 'pinning', card_url: cardUrl, metadata_hash_hex: hash, n, token_id: tokenId, token_address: built.token_address ?? null });
    return { token_id: tokenId, token_address: built.token_address ?? null, card_url: cardUrl, metadata_hash_hex: hash, transaction: cis8004Descriptor(setUri, schema) };
  }

  async function card(account, n) {
    const rec = await kv.get('open_card', cardKey(account, Number(n)));
    return rec ? rec.content : null;
  }

  // ---- 2. listing ----
  async function challenge({ account, agent_token }) {
    if (!isAddress(account)) throw bad('bad_account', 'Connect a Concordium account first.');
    const tokenId = Number(agent_token);
    if (!Number.isInteger(tokenId) || tokenId < 1) throw bad('bad_token', 'Pick the agent token you want to sell with.');
    const nonce = randomBytes(16).toString('hex');
    const expiresIso = new Date(now() + OPEN_POLICY.challengeTtlMs).toISOString();
    const message = listingChallengeText({ account, agentToken: tokenId, nonce, expiresIso, payer, registry });
    await kv.put('open_challenge', nonce, { account, agent_token: tokenId, message, expires_ms: now() + OPEN_POLICY.challengeTtlMs, used: false });
    return { nonce, message, expires_at: expiresIso };
  }

  async function list({ account, agent_token, nonce, signature }, { ip = 'unknown' } = {}) {
    await load();
    if (!isAddress(account)) throw bad('bad_account', 'Connect a Concordium account first.');
    const tokenId = Number(agent_token);
    const ch = typeof nonce === 'string' ? await kv.get('open_challenge', nonce) : null;
    const challengeOk = Boolean(ch && !ch.used && ch.account === account && ch.agent_token === tokenId && ch.expires_ms > now());
    let signatureOk = false; let signatureError = null;
    if (challengeOk && signature && typeof signature === 'object') {
      try { signatureOk = await chain.verifySignature(account, ch.message, signature); } catch (e) { signatureOk = false; signatureError = String(e?.message ?? e).slice(0, 160); }
    }
    let agent = null;
    try { agent = await chain.agentOf(tokenId); } catch { agent = null; }
    const tokenAddress = mcp.tokenAddress(tokenId);
    let badge = null;
    try { badge = await mcp.checkBadge(tokenAddress); } catch { badge = null; }
    let vendorRow = null;
    try { vendorRow = await chain.getVendor(payer, account); } catch { vendorRow = null; }
    const alreadyListed = listed.has(account) || Boolean(vendorRow);
    const budget = hitWindow ? await hitWindow('open:listings:day', 86_400_000, OPEN_POLICY.listingsPerDay) : { allowed: true };
    const decision = listingDecision({ account, agent, badge, signatureOk, signatureError, challengeOk, alreadyListed, budgetOk: budget.allowed, internalAccounts });
    if (!decision.allow) {
      // A seller that is already on the list on chain (e.g. re-onboarding) is restored into the mirror, not refused.
      if (alreadyListed && decision.checks.filter((c) => c.status === 'fail').every((c) => c.id === 'not_listed') && vendorRow && !listed.has(account)) {
        const rec = { account, agent_token: tokenId, badge: tokenAddress, tier: vendorRow.tier, caps: vendorRow, listing_tx: null, listed_at: new Date(now()).toISOString(), invoices: [] };
        listed.set(account, rec); await kv.put('open_seller', account, rec);
        return { listed: true, restored: true, checks: decision.checks, listing: rec };
      }
      return { listed: false, checks: decision.checks };
    }
    await kv.put('open_challenge', nonce, { ...ch, used: true });
    const sent = await chain.approveVendor(account, { tier: OPEN_POLICY.tier, perCap: OPEN_POLICY.perPayableCapMicro, periodCap: OPEN_POLICY.periodCapMicro, periodSecs: OPEN_POLICY.periodSecs });
    if (sent.outcome !== 'success') {
      return { listed: false, checks: decision.checks, listing_tx: sent.txHash ?? null, explorer_url: txLink(sent.txHash), error: `approve_vendor did not succeed (${sent.reject ?? sent.outcome})` };
    }
    const rec = {
      account, agent_token: tokenId, badge: tokenAddress, tier: OPEN_POLICY.tier,
      caps: { per_payable_ccd: microToCcd(OPEN_POLICY.perPayableCapMicro), period_ccd: microToCcd(OPEN_POLICY.periodCapMicro), period_secs: OPEN_POLICY.periodSecs },
      agent_wallet: agent?.agentWallet ?? agent?.agent_wallet ?? null,
      listing_tx: sent.txHash, listed_at: new Date(now()).toISOString(), invoices: [], ip_hash: sha256Hex(String(ip)).slice(0, 12),
    };
    listed.set(account, rec);
    await kv.put('open_seller', account, rec);
    return { listed: true, checks: decision.checks, listing: { ...rec, explorer_url: txLink(sent.txHash) } };
  }

  // ---- 3. invoices ----
  function publicInvoice(inv) {
    return {
      seller: inv.seller, payable_id: inv.payable_id, amount_ccd: microToCcd(inv.amount_micro), payee: inv.payee, due: inv.due,
      description: inv.description, doc_sha256: inv.doc_sha256, status: inv.status, register_tx: inv.register_tx ?? null,
      register_explorer_url: txLink(inv.register_tx), payment: inv.payment ?? null,
      pay_url: `/app/pay/${inv.seller}/${inv.payable_id}`, receipt_url: `/app/receipt/${inv.seller}/${inv.payable_id}`,
    };
  }

  async function draftInvoice({ seller, amount_ccd, description, due_days, payee }) {
    await load();
    const rec = sellerRecord(seller);
    if (!rec) throw conflict('not_listed', 'List your seller first (step 3). Invoices from unlisted sellers are refused by the buyer.');
    const amountMicro = parseCcd(amount_ccd);
    if (amountMicro <= 0n) throw bad('bad_amount', 'Amount must be above zero.');
    if (amountMicro > OPEN_POLICY.perPayableCapMicro) throw bad('over_cap', `Your listing allows up to ${microToCcd(OPEN_POLICY.perPayableCapMicro)} CCD per invoice. The contract itself would revert a larger payment (-23).`);
    const days = Number(due_days ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > OPEN_POLICY.maxDueDays) throw bad('bad_due', `Due date must be 1-${OPEN_POLICY.maxDueDays} days from now.`);
    const desc = cleanText(description, OPEN_POLICY.maxDescription);
    if (desc.length < 3) throw bad('bad_description', 'Say what the invoice is for (3-280 characters).');
    const allowedPayees = [seller, rec.agent_wallet].filter(Boolean);
    const pay = payee || seller;
    if (!isAddress(pay) || !allowedPayees.includes(pay)) throw bad('bad_payee', 'The payee must be your own account or your agent\'s agentWallet. PayOnce never pays a third account named by a seller.');
    const payableId = Math.floor(now() / 1000);
    const dueIso = new Date(Math.floor((now() + days * 86_400_000) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
    const doc = openInvoiceDocument({ seller, payableId, agentToken: rec.agent_token, badge: rec.badge, description: desc, amountMicro, payee: pay, dueIso, payer, registry });
    const docHash = sha256Hex(doc);
    const inv = { seller, payable_id: payableId, amount_micro: amountMicro.toString(), payee: pay, due: dueIso, description: desc, doc, doc_sha256: docHash, agent_token: rec.agent_token, status: 'draft', created_at: new Date(now()).toISOString() };
    await kv.put('open_invoice', `${seller}:${payableId}`, inv);
    return {
      invoice: publicInvoice(inv),
      document: doc,
      transaction: {
        kind: 'update_contract',
        contract: { index: registry.index, subindex: registry.subindex },
        receive_name: `${registry.name}.register_payable`,
        amount_micro_ccd: '0',
        max_energy: 9000,
        parameter_json: registerPayableParameterJson({ payableId, payee: pay, amountMicro, dueIso, docHashHex: docHash, agentToken: rec.agent_token, payer }),
        schema: schemaB64() ? { type: 'parameter', value: schemaB64() } : null,
      },
    };
  }

  /** After the wallet's register_payable finalizes: the chain row must match the draft exactly. */
  async function recordInvoice({ seller, payable_id, tx_hash }) {
    await load();
    const key = `${seller}:${Number(payable_id)}`;
    const inv = await kv.get('open_invoice', key);
    if (!inv) throw new OpenError(404, 'no_draft', 'No draft for that invoice. Draft it first.');
    const view = await chain.getPayable(seller, Number(payable_id));
    if (!view) throw conflict('not_on_chain', 'The payable is not on the registry yet. Wait for the transaction to finalize, then try again.');
    const mism = [];
    if (String(view.docHash).toLowerCase() !== inv.doc_sha256) mism.push('doc_hash');
    if (String(view.amount) !== String(inv.amount_micro)) mism.push('amount');
    if (view.payee !== inv.payee) mism.push('payee');
    if (view.asset !== 'CCD') mism.push('asset');
    if (view.expectedPayer !== payer) mism.push('expected_payer');
    if (String(view.agentToken) !== String(inv.agent_token)) mism.push('agent_token');
    if (mism.length) throw conflict('chain_mismatch', `The registered payable differs from the draft (${mism.join(', ')}). It will not be served as a PayOnce open invoice.`);
    const next = { ...inv, status: view.status === 'Paid' ? 'paid' : 'open', register_tx: typeof tx_hash === 'string' && /^[0-9a-f]{64}$/i.test(tx_hash) ? tx_hash.toLowerCase() : inv.register_tx ?? null, recorded_at: new Date(now()).toISOString() };
    await kv.put('open_invoice', key, next);
    const rec = sellerRecord(seller);
    if (rec && !rec.invoices.includes(next.payable_id)) {
      rec.invoices = [...rec.invoices, next.payable_id];
      await kv.put('open_seller', seller, rec);
    }
    await onInvoiceRecorded(seller, next.payable_id);
    return { invoice: publicInvoice(next) };
  }

  async function documentFor(seller, id) {
    const inv = await kv.get('open_invoice', `${seller}:${Number(id)}`);
    if (!inv || inv.status === 'draft') return null;
    return Buffer.from(inv.doc, 'utf8');
  }

  async function invoiceKeys() {
    await load();
    const out = [];
    for (const rec of listed.values()) for (const id of rec.invoices ?? []) out.push({ seller: rec.account, id });
    return out;
  }

  // ---- 4. the buyer agent pays ----
  const paying = new Set();
  async function agentPay({ seller, id }, { ip = 'unknown' } = {}) {
    await load();
    const key = `${seller}:${Number(id)}`;
    const inv = await kv.get('open_invoice', key);
    if (!inv || inv.status === 'draft') throw new OpenError(404, 'no_invoice', 'No recorded open invoice with that key.');
    if (inv.status === 'paid') return { already_paid: true, invoice: publicInvoice(inv) };
    if (paying.has(key)) throw conflict('agent_busy', 'The buyer agent is already working on this invoice.', { retryable: true });
    if (hitWindow) {
      const w = await hitWindow(`open:agentpay:${sha256Hex(String(ip)).slice(0, 12)}`, 3_600_000, 6);
      if (!w.allowed) throw new OpenError(429, 'rate_limited', 'At most 6 agent payments per hour from one address.', { retryable: true });
      const g = await hitWindow('open:agentpay:global', 3_600_000, 30);
      if (!g.allowed) throw new OpenError(429, 'rate_limited', 'The demo buyer agent pays at most 30 open invoices per hour.', { retryable: true });
    }
    paying.add(key);
    try {
      const result = await payWithAgent({ seller, id: Number(id), docText: inv.doc, expectedAmount: inv.amount_micro });
      if (result?.paid) {
        const next = { ...inv, status: 'paid', payment: { txs: result.txs ?? [], job_id: result.job_id ?? null, paid_at: new Date(now()).toISOString() } };
        await kv.put('open_invoice', key, next);
        await onInvoiceRecorded(seller, Number(id));
        return { paid: true, result, invoice: publicInvoice(next) };
      }
      return { paid: false, result, invoice: publicInvoice(inv) };
    } finally {
      paying.delete(key);
    }
  }

  return { load, config, status, startAgent, finishAgent, card, challenge, list, draftInvoice, recordInvoice, documentFor, invoiceKeys, agentPay, isListedSync, sellerRecord, allListed };
}
