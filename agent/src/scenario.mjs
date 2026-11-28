// One complete agent run against a PayOnce API, recorded as a JSON document.
// Used by the CLI (agent/run.mjs, writes qa/out/agent-run-<date>.json) and by the API's rate-limited
// "Run the agent" endpoint. The record is the single source the app's "Agent pays" page renders.
import { randomBytes } from 'node:crypto';
import { PayOnceClient } from './client.mjs';
import { buildTools } from './tools.mjs';
import { makeMandate } from './policy.mjs';
import { buildRunInbox } from './inbox.mjs';
import { runAgent } from './agent.mjs';
import { ScriptedPlanner, LlmPlanner, NearAiPlanner } from './planners.mjs';
import { envSecrets, safeError } from './util.mjs';

export const RUN_SCHEMA = 'payonce.agent-run/1';

export const HONESTY = [
  'Testnet only. Every transaction hash in this record is a Concordium testnet transaction; nothing here is real money.',
  'The inbox emails are seed data (fixtures written for this demo). The payables they point at are real rows on the PayOnce registry, and the payments are real testnet transactions.',
  'Payments go through the PayOnce API: the payer account signs under the vendor list, the per-payable mandate and the pre-sign policy gate. On the EUDemo rail a refusal is the policy gate deciding off-chain (deterministic policy run by the operator), not a chain revert. On the CCD rail the contract itself reverts a second payment.',
  'The 18+ age gate is enforced by the server and the verifier (the CCD contract cannot verify a zero-knowledge proof). The proof, when present, is a V&A V1 presentation from the paying account\'s credential, produced by the scoped prover, a separate service from the API that holds only the dob and nationality openings (a stand-in for Concordium\'s coming Agent IDP).',
  'The seller is an identity-backed account with an Active CIS-8004 token on the official registry <12802,0>. There is no company or LEI proof.',
  'The buyer agent (token 1488) has no published agent card, so the full 15-check badge cannot run for it; the seller-side gate is Active + owner + agentWallet equal to the paying account.',
];

export const nearKeys = (env) => [env.NEAR_AI_API_KEY, env.NEARAI_API_KEY, env.NEARAI_CLOUD_API_KEY].filter(Boolean).filter((k, i, a) => a.indexOf(k) === i);

export function pickPlanner(env = process.env, fetchImpl = fetch) {
  if (env.PAYONCE_AGENT_PLANNER !== 'scripted' && nearKeys(env).length) return new NearAiPlanner({ apiKeys: nearKeys(env), baseUrl: env.LLM_BASE_URL || undefined, model: env.LLM_MODEL || undefined, fetchImpl });
  if (env.ANTHROPIC_API_KEY && env.PAYONCE_AGENT_PLANNER !== 'scripted') return new LlmPlanner({ apiKey: env.ANTHROPIC_API_KEY, fetchImpl });
  return new ScriptedPlanner();
}

/** An age-proof provider that talks to the API's /api/age-proof routes (which anchor the request and proxy the scoped prover). */
export function apiAgeProofProvider({ client }) {
  return async ({ id }) => {
    let health;
    try { health = await client.ageProofHealth(); } catch (e) { return { ok: false, error: `age-proof health failed: ${safeError(e)}` }; }
    if (!health?.prover_available) return { ok: false, error: 'prover_unavailable: the scoped prover (a separate service holding the dob and nationality openings) is not reachable from this API', http: 503 };
    const r = await client.ageProofV1({ payableId: id });
    const b = r.body ?? {};
    if (r.status === 200 && b.ok && b.binding === 'bound') {
      return { ok: true, binding: b.binding, statements: b.statements, holder: b.holder, vra_tx: b.vra_tx, vaa_tx: b.vaa_tx, verified_at: b.verified_at, steps: b.steps };
    }
    return { ok: false, http: r.status, binding: b.binding ?? null, error: b.error?.message ?? b.error ?? `proof not filed (binding: ${b.binding ?? 'unknown'})`, steps: b.steps ?? null };
  };
}

/**
 * @param {object} o
 * @param {string} o.apiUrl
 * @param {object} [o.env]
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.exec]       local keyless verifier runner
 * @param {Function} [o.log]
 * @param {boolean} [o.withAgeProof] provide the age-proof provider (the API decides if a prover exists)
 */
export async function runScenario({ apiUrl, env = process.env, fetchImpl = fetch, exec = null, log = () => {}, planner = null, headers = {}, onEvent = null, variant = null }) {
  const secrets = envSecrets(env);
  const client = new PayOnceClient({ baseUrl: apiUrl, fetchImpl, secrets, headers });
  const startedAt = new Date().toISOString();
  let cfg = await client.config({ fresh: true });
  // The vendor list is read from the chain; a busy public node can return it empty. Retry, then fail loudly
  // rather than run an agent whose mandate approves nobody.
  for (let i = 0; i < 4 && !(cfg.vendor_list ?? []).length; i += 1) { log('vendor list empty (node busy?), re-reading'); await new Promise((r) => setTimeout(r, 12_000)); cfg = await client.config({ fresh: true }); }
  if (!(cfg.vendor_list ?? []).length) throw new Error('the vendor list could not be read from the chain; refusing to run');
  const mandate = makeMandate({ approvedSuppliers: (cfg.vendor_list ?? []).map((v) => v.seller) });
  const { emails, setup } = await buildRunInbox({ client, log, variant });
  const tools = buildTools({ client, canPay: true, exec });
  const pl = planner ?? pickPlanner(env, fetchImpl);
  const payer = cfg.buyer_agent?.account ?? null;
  const ageProof = apiAgeProofProvider({ client });
  log(`agent: ${pl.label}`);
  const result = await runAgent({ mandate, emails, tools, planner: pl, ageProof, secrets, onEvent: (e) => { if (onEvent) onEvent(e); if (e.type !== 'tool_result') log(`  ${e.type}${e.tool ? ' ' + e.tool : ''}${e.text ? ': ' + e.text.slice(0, 140) : e.summary ? ': ' + e.summary : ''}`); } });
  const finishedAt = new Date().toISOString();
  return {
    schema: RUN_SCHEMA,
    run_id: `run-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`,
    network: 'testnet',
    api: apiUrl,
    started_at: startedAt,
    finished_at: finishedAt,
    planner: { kind: pl.kind, label: pl.label, model: pl.model ?? null, provider: pl.provider ?? null },
    variant: variant ?? 'standard',
    task: mandate.text,
    mandate: { approved_suppliers: mandate.approvedSuppliers, budget: { ccd: mandate.budget.ccd.toString(), eudemo: mandate.budget.eudemo.toString() }, rules: mandate.rules },
    registry: `<${cfg.registry?.index},${cfg.registry?.subindex}>`,
    buyer_agent: { token: cfg.buyer_agent?.token_id ?? cfg.buyer_agent?.tokenId ?? null, account: payer },
    honesty: HONESTY,
    setup,
    decisions: result.decisions,
    totals: result.totals,
    final: result.final,
    transcript: result.transcript,
  };
}
