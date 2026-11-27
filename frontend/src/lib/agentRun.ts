// The agent run record (agent/src/scenario.mjs, schema payonce.agent-run/1) and the helpers the
// "Agent pays" page uses. Nothing here invents data: every field is read from a recorded or live run.

export interface AgentCheck {
  id: string
  label: string
  status: 'ok' | 'fail' | 'warn' | 'not_run' | string
  side?: 'seller' | 'buyer' | 'doc' | 'chain' | 'input' | 'server' | string
  detail?: string
}

export interface AgentTx {
  step?: string
  tx_hash: string
  explorer_url?: string
}

export interface AgentDecision {
  email_id: string
  from: string
  subject: string
  hostile_fixture: string | null
  seller: string | null
  payable_id: number | null
  outcome: 'paid' | 'refused' | 'held' | 'not_processed' | 'pending' | string
  verdict?: string
  reason_code?: string
  reason?: string
  refused_by?: string | null
  checks: AgentCheck[]
  facts?: { asset?: string; amount_display?: string; payee?: string; status?: string } | null
  seller_agent?: { token?: number; badge_valid?: boolean; status?: string } | null
  buyer_agent?: { token?: number | null; verdict?: string | null } | null
  age_gate?: { required?: boolean; reason?: string | null; proof_on_file?: boolean | null } | null
  age_proof?: { ok: boolean; binding?: string; reason?: string | null; vra_tx?: string; vaa_tx?: string } | null
  txs?: AgentTx[]
  rail?: string
  receipt?: { amount?: string; payee?: string; verifier_reread?: { passed: number; total: number } | null; anchor_tx?: string | null } | null
  keyless_verifier?: { fetch_document: string; run: string } | null
  verifier_run?: { ran: boolean; pass?: boolean; passed?: number | null; total?: number | null; command?: string } | null
}

export interface AgentEvent {
  seq: number
  at: string
  type: string
  tool?: string
  text?: string
  summary?: string
  allow?: boolean
}

export interface AgentRun {
  schema: string
  run_id: string
  network: string
  api: string
  started_at: string
  finished_at: string
  planner: { kind: 'scripted' | 'llm' | string; label: string; model: string | null }
  task: string
  mandate: { approved_suppliers: string[]; budget: { ccd: string; eudemo: string }; rules: string[] }
  buyer_agent?: { token: number | null; account: string | null }
  honesty: string[]
  setup?: { registered?: Array<{ key: string; payable_id: number; tx_hash: string }>; reused?: Array<{ role: string; payable_id: number }> }
  decisions: AgentDecision[]
  totals: { paid: number; refused: number; held: number; spent: { ccd: string; eudemo: string } }
  final: string
  transcript: AgentEvent[]
  _source?: { kind: 'live' | 'recorded'; file?: string; note?: string }
}

export function isAgentRun(x: unknown): x is AgentRun {
  const r = x as Partial<AgentRun> | null
  return Boolean(r && r.schema === 'payonce.agent-run/1' && Array.isArray(r.decisions) && r.planner && r.mandate)
}

export const SIDE_TITLE: Record<string, string> = {
  seller: 'The buyer checks the seller',
  buyer: 'The seller checks the buyer',
  doc: 'The invoice and the email',
  chain: 'The registry',
}
export const SIDE_ORDER = ['seller', 'buyer', 'doc', 'chain']

/** Group a decision's checks by who checks whom. Checks with no side land in "chain". */
export function groupChecks(checks: AgentCheck[]): Array<{ side: string; title: string; checks: AgentCheck[] }> {
  const by = new Map<string, AgentCheck[]>()
  for (const c of checks) {
    const side = c.side && SIDE_TITLE[c.side] ? c.side : 'chain'
    by.set(side, [...(by.get(side) ?? []), c])
  }
  return SIDE_ORDER.filter((s) => by.has(s)).map((side) => ({ side, title: SIDE_TITLE[side], checks: by.get(side) ?? [] }))
}

export function outcomeLabel(o: string): string {
  return o === 'paid' ? 'Paid' : o === 'refused' ? 'Refused' : o === 'held' ? 'Waiting for the owner' : o === 'not_processed' ? 'Not processed' : 'Pending'
}

export function outcomeTone(o: string): 'ok' | 'bad' | 'warn' | 'neutral' {
  return o === 'paid' ? 'ok' : o === 'refused' ? 'bad' : o === 'held' ? 'warn' : 'neutral'
}

/** A plain label for the planner, never blurring a script with a language model. */
export function plannerBadge(p: AgentRun['planner']): string {
  return p.kind === 'llm' ? `Language model: ${p.model ?? 'Claude'}` : 'Scripted agent (not a language model)'
}

export function hostileLabel(h: string | null): string | null {
  return h === 'unlisted_seller' ? 'Hostile: unapproved seller' : h === 'tampered_document' ? 'Hostile: edited invoice with an instruction for the agent' : h === 'payee_change' ? 'Hostile: asks to pay another account' : null
}

export function refusedByLayer(by: string | null | undefined): string {
  if (!by) return ''
  if (/mandate/i.test(by)) return 'Agent mandate'
  if (/PayOnce check/i.test(by)) return 'PayOnce check, before any transaction'
  if (/API/i.test(by)) return 'PayOnce API'
  return by
}
