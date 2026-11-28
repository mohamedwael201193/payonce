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
  source?: string
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
  post_run_notes?: Array<{ payable_id: number; text: string; confirm_tx?: string }>
  variant?: string
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
  return p.kind === 'llm' ? `Language model: ${p.label}` : 'Scripted agent (not a language model)'
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

// ---- grounding the model's prose in the run record ----------------------
// The model writes free text; the run record (decisions, txs, post-run notes)
// is the authority. A sentence that names a payable and says the opposite of
// what the record shows (e.g. "1503 remains actionable" when 1503 was paid) is
// marked with the recorded outcome, so the page never lets prose overrule data.

export type SettledOutcome = 'paid' | 'refused' | 'held' | 'other'

/** The outcome the run record shows for one payable id, counting a confirm finished after the run. */
export function recordedOutcome(run: Pick<AgentRun, 'decisions' | 'post_run_notes'>, id: number): SettledOutcome | null {
  const d = run.decisions.filter((x) => x.payable_id === id)
  const note = run.post_run_notes?.find((n) => n.payable_id === id && n.confirm_tx)
  if (note) return 'paid'
  if (!d.length) return null
  if (d.some((x) => x.outcome === 'paid')) return 'paid'
  if (d.some((x) => x.outcome === 'refused')) return 'refused'
  if (d.some((x) => x.outcome === 'held')) return 'held'
  return 'other'
}

export interface ProseCorrection {
  payable_id: number
  says: 'not_paid' | 'paid'
  record: SettledOutcome
  text: string
}

const NOT_PAID_RE =
  /\b(remains?|is still|still|stays?)\s+(actionable|open|unpaid|outstanding|pending|due|reserved)\b|\bnot\s+(yet\s+)?(been\s+)?paid\b|\b(was|wasn't|is|isn't)\s+not\s+paid\b|\bunpaid\b|\blimbo\b|\bstill needs? (to be )?pa(id|ying)\b/i
const PAID_RE = /\b(was|is|got|has been|have been)\s+(successfully\s+)?(paid|settled)\b|\bpaid\s+(successfully|in full)\b/i
const REFUSAL_RE = /\b(refus|reject|block|declin|not\s+pa|unpaid|skip)/i

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function idsIn(sentence: string, known: Set<number>): number[] {
  const out = new Set<number>()
  for (const m of sentence.matchAll(/(?:payable|invoice|#)\s*#?\s*(\d{1,6})\b/gi)) out.add(Number(m[1]))
  for (const m of sentence.matchAll(/\b(\d{3,6})\b/g)) if (known.has(Number(m[1]))) out.add(Number(m[1]))
  return [...out].filter((n) => known.has(n))
}

/** Sentences in a piece of model prose that contradict the run record, one entry per (sentence, payable). */
export function groundProse(text: string, run: Pick<AgentRun, 'decisions' | 'post_run_notes'>): ProseCorrection[] {
  const known = new Set<number>(run.decisions.map((d) => d.payable_id).filter((n): n is number => typeof n === 'number'))
  for (const n of run.post_run_notes ?? []) known.add(n.payable_id)
  const out: ProseCorrection[] = []
  for (const s of splitSentences(text)) {
    const ids = idsIn(s, known)
    if (!ids.length) continue
    // Only judge a sentence about one payable; a list sentence mixes outcomes and stays as written.
    if (ids.length > 1) continue
    const id = ids[0]
    const record = recordedOutcome(run, id)
    if (!record) continue
    if (record === 'paid' && NOT_PAID_RE.test(s)) out.push({ payable_id: id, says: 'not_paid', record, text: s })
    else if (record === 'refused' && PAID_RE.test(s) && !REFUSAL_RE.test(s)) out.push({ payable_id: id, says: 'paid', record, text: s })
  }
  return out
}

/** One plain line for a correction, built only from the run record. */
export function correctionText(c: ProseCorrection, run: Pick<AgentRun, 'decisions' | 'post_run_notes'>): string {
  if (c.record === 'paid') {
    const note = run.post_run_notes?.find((n) => n.payable_id === c.payable_id && n.confirm_tx)
    const d = run.decisions.find((x) => x.payable_id === c.payable_id && x.outcome === 'paid')
    const v = d?.receipt?.verifier_reread
    const proof = v ? `, verifier ${v.passed}/${v.total}` : ''
    return note
      ? `Run record: payable ${c.payable_id} was paid; its confirm finished after the run (${note.confirm_tx?.slice(0, 8)}…).`
      : `Run record: payable ${c.payable_id} was paid${proof}. The model's sentence is wrong about this.`
  }
  return `Run record: payable ${c.payable_id} was refused and nothing was paid. The model's sentence is wrong about this.`
}
