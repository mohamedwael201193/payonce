// Types for the P3 §16 API contract. Amounts are strings in base units
// (micro CCD, or raw EUDemo with 6 decimals). The UI formats them.

export type Layer = 'app' | 'chain' | 'co_signer' | 'node' | 'server'
export type CheckStatus = 'ok' | 'fail' | 'not_run' | 'info'
export type PayableStatusKind = 'unpaid' | 'reserved' | 'paid'

export interface RejectInfo {
  code: number
  name: string
  plain: string
}

export interface ApiErrorBody {
  code: string
  layer: Layer
  message: string
  retryable: boolean
  reject?: RejectInfo | null
  fee_testnet_ccd?: string | null
  tx_hash?: string | null
  explorer_url?: string | null
  retry_after_s?: number | null
}

export class ApiError extends Error {
  body: ApiErrorBody
  status: number
  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.status = status
    this.body = body
  }
}

export interface ApiConfig {
  network: string
  registry: { index: number; subindex: number; module_ref: string }
  cis8004_test_instance: {
    index: number
    subindex: number
    official_module_ref: string
    is_official_registry: boolean
  }
  reservation_secs: number
  co_signer_margin_secs: number
  assets: Record<string, { decimals: number; label: string }>
  payer_label: string
  sponsor_label: string
  explorer: { tx: string; instance: string }
  vendor_list: Array<{ seller: string; label: string }>
  sellers?: Array<{
    seller: string
    label: string
    agent_token: number
    badge: string
    badge_url: string
    agent_card_url: string
  }>
  build: {
    vendor_list_enforced_by_co_signer: boolean
    named_payer_on_invoice: boolean
    confirm_by: string
    header_expiry_bound: boolean
    co_signer_runs_as: string
  }
  limits: { new_invoices_per_hour: number | string; attempts_per_minute_per_ip: number | string }
  verifier: { file: string; version_date: string }
  as_of: string
}

export interface Health {
  chain: { reachable: boolean; checked_at: string }
  node_busy: boolean
  payer: { status: 'ok' | 'low' | 'empty'; refilling?: boolean; reason?: string | null }
  fee_guard?: { enabled: boolean; refilling: boolean; last_refill_at?: string | null; last_refill_tx?: string | null; refills_24h?: number }
  sponsor: { status: 'ok' | 'low' | 'empty' }
  wallet_eudemo: { status: 'ok' | 'low' }
  co_signer: { status: 'ok' | 'unavailable' }
  budget: { new_invoices_left_this_hour: number; attack_sends_left_this_hour: number }
}

export interface Stats {
  payables_total: number
  paid_total: number
  refused_on_chain_since_deploy: number
  last_verifier_run_at: string | null
  // Excluded rows are reported, not hidden: Voided / Reserved payables are
  // scanned on chain but never listed, so the total can never exceed the list.
  voided_total?: number
  reserved_total?: number
  /** Where each figure comes from: kind is 'live', 'recorded' or 'server'. */
  sources?: Record<string, { kind: string; basis?: string }>
  /** One id per complete registry scan on the API. Stats and the invoice list
      carry the same id when they describe the same scan. Absent on an old API. */
  scan_id?: string
  /** True: this body is built from a COMPLETE scan (the API never serves partial ones). */
  complete?: boolean
  /** When the scan this body describes finished (not when it was requested). */
  generated_at?: string
  /** Demo invoices vs automated test runs, both counted in payables_total. */
  by_kind?: KindCounts
}

export interface KindCounts {
  demo: { total: number; paid: number }
  matrix: { total: number; paid: number }
  lab: { total: number; paid: number }
  test_runs: { total: number; paid: number }
  rule?: string
}

export type InvoiceKind = 'demo' | 'matrix' | 'lab'

export interface InvoicePage {
  items: InvoiceItem[]
  scan_id?: string
  complete?: boolean
  generated_at?: string
}

export interface InvoiceItem {
  payable_id: number
  seller: string
  asset: 'ccd' | 'eudemo'
  amount_display: string
  due: string
  status: string
  label: string
  /** demo = curated demo invoice; matrix / lab = automated test runs. Absent on an old API. */
  kind?: InvoiceKind
}

export interface PayableFacts {
  payable_id: number
  asset: { kind: 'ccd' | 'eudemo'; token: string }
  amount: string
  amount_display: string
  payee: string
  seller: string
  due: string
  is_past_due: boolean
  status:
    | { kind: 'unpaid' }
    | { kind: 'reserved'; payer: string; expires: string }
    | { kind: 'voided' }
    | {
        kind: 'paid'
        payer: string
        paid_at: string
        payment_tx: string
        payment_tx_source: 'chain' | 'server_store'
      }
  agent: { registry: { index: number; subindex: number }; token: string }
  doc_sha256: string
  label: string
}

export interface CheckRow {
  id: string
  label: string
  status: CheckStatus
  detail: string
  layer: Layer
}

export interface VerifyResponse {
  payable_id: number
  mode: 'before_pay' | 'after_pay'
  verdict: 'ready' | 'blocked' | 'paid'
  passed: number
  total: number
  blocked_reason: string | null
  checks: CheckRow[]
  checked_at: string
  read_ms: number
}

export interface PayJob {
  job_id: string
  payable_id: number
  rail: 'ccd' | 'eudemo'
  steps: string[]
}

export type JobState = 'running' | 'succeeded' | 'refused' | 'failed'

export interface JobStep {
  step: string
  status: 'pending' | 'running' | 'ok' | 'failed' | 'refused' | 'retrying'
  detail: string
  txHash?: string | null
  explorerUrl?: string | null
  elapsed_ms?: number
  layer?: Layer
  reject?: RejectInfo | null
}

export interface JobSnapshot {
  job_id: string
  payable_id: number
  rail: 'ccd' | 'eudemo'
  state: JobState
  steps: JobStep[]
  outcome: 'paid' | 'refused' | 'failed' | null
  started_at: string
  finished_at: string | null
}

export interface Receipt {
  payable_id: number
  seller?: string
  amount_display: string
  payee: string
  payer_label: string
  txs: Array<{ label: string; tx_hash: string; explorer_url: string }>
  verifier: { passed: number; total: number; checked_at: string } | null
  payment_tx_source: 'chain' | 'server_store'
}

export interface AttackResult {
  kind: string
  payable_id: number
  layer: Layer
  live: boolean
  seller?: string | null
  tx_sent: boolean
  outcome: string
  reject?: RejectInfo | null
  fee_testnet_ccd?: string | null
  tx_hash?: string | null
  explorer_url?: string | null
  recorded_example?: unknown
  plain: string
}

export interface RecordedRun {
  payable_id: number
  seller?: string
  date: string
  steps: Array<{ step: string; detail: string; txHash?: string | null; layer?: Layer }>
}

export interface JudgeFile {
  name: string
  url: string
  sha256: string
}

export interface AgeProofHealth {
  service: string
  prover_available: boolean
  prover: {
    service: string
    network: string
    attributes_held: string[]
    issuer_did: string | null
    allow_list: string[]
    refuses: string[]
  }
  anchored_run: {
    vra: string
    vaa: string
    record_sha256: string
    statements: string[]
  }
  proven_rejections: string[]
  checked_at: string
}

export interface AgeProofPolicyDecision {
  allowed: boolean
  rule: string
  reason: string
}

export interface AgeProofVerifyResult {
  valid: boolean
  statements?: string[]
  filed_for_payable?: number | null
  holder?: string | null
  binding?: string
  verified_at?: string
  verifier_status?: number
  reason?: string
}
