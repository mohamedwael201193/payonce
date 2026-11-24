// Typed API client for the P3 §16 contract. JSON only. No endpoint returns
// a key, a seed or a .env value. Reads and submissions retry 1s / 2s / 4s
// (three tries, §7.5) on node_busy / chain_unreachable / HTTP 429.
import { z } from 'zod'
import type {
  ApiConfig,
  ApiErrorBody,
  AttackResult,
  Health,
  InvoiceItem,
  JobSnapshot,
  JudgeFile,
  PayableFacts,
  PayJob,
  Receipt,
  RecordedRun,
  Stats,
  VerifyResponse,
} from './types'
import { ApiError } from './types'

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

const errorBodySchema = z.object({
  code: z.string(),
  layer: z.enum(['app', 'chain', 'co_signer', 'node', 'server']),
  message: z.string(),
  retryable: z.boolean(),
  reject: z
    .object({ code: z.number(), name: z.string(), plain: z.string() })
    .nullable()
    .optional(),
  fee_testnet_ccd: z.string().nullable().optional(),
  tx_hash: z.string().nullable().optional(),
  explorer_url: z.string().nullable().optional(),
  retry_after_s: z.number().nullable().optional(),
})

const configSchema = z.object({
  network: z.string(),
  registry: z.object({ index: z.number(), subindex: z.number(), module_ref: z.string() }),
  cis8004_test_instance: z.object({
    index: z.number(),
    subindex: z.number(),
    official_module_ref: z.string(),
    is_official_registry: z.boolean(),
  }),
  reservation_secs: z.number(),
  co_signer_margin_secs: z.number(),
  assets: z.record(z.object({ decimals: z.number(), label: z.string() })),
  payer_label: z.string(),
  sponsor_label: z.string(),
  explorer: z.object({ tx: z.string(), instance: z.string() }),
  vendor_list: z.array(z.object({ seller: z.string(), label: z.string() })),
  build: z.object({
    vendor_list_enforced_by_co_signer: z.boolean(),
    named_payer_on_invoice: z.boolean(),
    confirm_by: z.string(),
    header_expiry_bound: z.boolean(),
    co_signer_runs_as: z.string(),
  }),
  limits: z.object({
    new_invoices_per_hour: z.union([z.number(), z.string()]),
    attempts_per_minute_per_ip: z.union([z.number(), z.string()]),
  }),
  verifier: z.object({ file: z.string(), version_date: z.string() }),
  as_of: z.string(),
})

const healthSchema = z.object({
  chain: z.object({ reachable: z.boolean(), checked_at: z.string() }),
  node_busy: z.boolean(),
  payer: z.object({ status: z.enum(['ok', 'low', 'empty']) }),
  sponsor: z.object({ status: z.enum(['ok', 'low', 'empty']) }),
  wallet_eudemo: z.object({ status: z.enum(['ok', 'low']) }),
  co_signer: z.object({ status: z.enum(['ok', 'unavailable']) }),
  budget: z.object({
    new_invoices_left_this_hour: z.number(),
    attack_sends_left_this_hour: z.number(),
  }),
})

const statsSchema = z.object({
  payables_total: z.number(),
  paid_total: z.number(),
  refused_on_chain_since_deploy: z.number(),
  last_verifier_run_at: z.string().nullable(),
})

const invoiceItemSchema = z.object({
  payable_id: z.number(),
  asset: z.enum(['ccd', 'eudemo']),
  amount_display: z.string(),
  due: z.string(),
  // The live API returns "Paid"/"Unpaid" (capitalized); the dev stub and
  // every consumer in this app use lowercase 'paid'/'unpaid'. Normalize at
  // the parse boundary so the console tabs, row labels, receipt checker
  // and rail links all see the same values against either source.
  status: z.string().transform((s) => s.toLowerCase()),
  label: z.string(),
})

const payableSchema = z.object({
  payable_id: z.number(),
  asset: z.object({ kind: z.enum(['ccd', 'eudemo']), token: z.string() }),
  amount: z.string(),
  amount_display: z.string(),
  payee: z.string(),
  seller: z.string(),
  due: z.string(),
  is_past_due: z.boolean(),
  status: z.union([
    z.object({ kind: z.literal('unpaid') }),
    z.object({ kind: z.literal('reserved'), payer: z.string(), expires: z.string() }),
    z.object({
      kind: z.literal('paid'),
      payer: z.string(),
      paid_at: z.string(),
      payment_tx: z.string(),
      payment_tx_source: z.enum(['chain', 'server_store']),
    }),
  ]),
  agent: z.object({
    registry: z.object({ index: z.number(), subindex: z.number() }),
    token: z.string(),
  }),
  doc_sha256: z.string(),
  label: z.string(),
})

const checkSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['ok', 'fail', 'not_run', 'info']),
  detail: z.string(),
  layer: z.enum(['app', 'chain', 'co_signer', 'node', 'server']),
})

const verifySchema = z.object({
  payable_id: z.number(),
  mode: z.enum(['before_pay', 'after_pay']),
  verdict: z.enum(['ready', 'blocked', 'paid']),
  passed: z.number(),
  total: z.number(),
  blocked_reason: z.string().nullable(),
  checks: z.array(checkSchema),
  checked_at: z.string(),
  read_ms: z.number(),
})

const jobSchema = z.object({
  job_id: z.string(),
  payable_id: z.number(),
  rail: z.enum(['ccd', 'eudemo']),
  state: z.enum(['running', 'succeeded', 'refused', 'failed']),
  steps: z.array(
    z.object({
      step: z.string(),
      status: z.enum(['pending', 'running', 'ok', 'failed', 'refused', 'retrying']),
      detail: z.string(),
      txHash: z.string().nullable().optional(),
      explorerUrl: z.string().nullable().optional(),
      elapsed_ms: z.number().optional(),
      layer: z.enum(['app', 'chain', 'co_signer', 'node', 'server']).optional(),
      reject: z
        .object({ code: z.number(), name: z.string(), plain: z.string() })
        .nullable()
        .optional(),
    }),
  ),
  outcome: z.enum(['paid', 'refused', 'failed']).nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
})

const receiptSchema = z.object({
  payable_id: z.number(),
  amount_display: z.string(),
  payee: z.string(),
  payer_label: z.string(),
  txs: z.array(z.object({ label: z.string(), tx_hash: z.string(), explorer_url: z.string() })),
  verifier: z
    .object({ passed: z.number(), total: z.number(), checked_at: z.string() })
    .nullable(),
  payment_tx_source: z.enum(['chain', 'server_store']),
})

const attackSchema = z.object({
  kind: z.string(),
  payable_id: z.number(),
  layer: z.enum(['app', 'chain', 'co_signer', 'node', 'server']),
  live: z.boolean(),
  tx_sent: z.boolean(),
  outcome: z.string(),
  reject: z
    .object({ code: z.number(), name: z.string(), plain: z.string() })
    .nullable()
    .optional(),
  fee_testnet_ccd: z.string().nullable().optional(),
  tx_hash: z.string().nullable().optional(),
  explorer_url: z.string().nullable().optional(),
  recorded_example: z.unknown().optional(),
  plain: z.string(),
})

const recordedSchema = z.object({
  payable_id: z.number(),
  date: z.string(),
  steps: z.array(
    z.object({
      step: z.string(),
      detail: z.string(),
      txHash: z.string().nullable().optional(),
      layer: z.enum(['app', 'chain', 'co_signer', 'node', 'server']).optional(),
    }),
  ),
})

const judgeFilesSchema = z.object({
  files: z.array(z.object({ name: z.string(), url: z.string(), sha256: z.string() })),
})

const RETRYABLE_CODES = new Set(['node_busy', 'chain_unreachable'])
const RETRY_DELAYS_MS = [1000, 2000, 4000]

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let res: Response
    try {
      res = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      })
    } catch (e) {
      // Network failure: retry like a busy node, then surface as chain_unreachable.
      lastErr = e instanceof Error ? e : new Error('Network error')
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      throw new ApiError(0, {
        code: 'chain_unreachable',
        layer: 'server',
        message: 'The testnet is not answering. Showing the last verified data.',
        retryable: true,
      })
    }
    if (res.ok) {
      const json: unknown = await res.json()
      const parsed = schema.safeParse(json)
      if (!parsed.success) {
        throw new ApiError(res.status, {
          code: 'internal',
          layer: 'server',
          message: 'Something went wrong on our side. Nothing was sent unless a transaction link appears above.',
          retryable: false,
        })
      }
      return parsed.data
    }
    const bodyJson: unknown = await res.json().catch(() => null)
    const parsedErr = errorBodySchema.safeParse(
      (bodyJson as { error?: unknown } | null)?.error ?? bodyJson,
    )
    const body: ApiErrorBody = parsedErr.success
      ? (parsedErr.data as ApiErrorBody)
      : {
          code: 'internal',
          layer: 'server',
          message: 'Something went wrong on our side. Nothing was sent unless a transaction link appears above.',
          retryable: false,
        }
    if (res.status === 429 || RETRYABLE_CODES.has(body.code)) {
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
    }
    throw new ApiError(res.status, body)
  }
  throw lastErr ?? new Error('Request failed')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const api = {
  getConfig: () => request<ApiConfig>('/api/config', configSchema),
  getHealth: () => request<Health>('/api/health', healthSchema),
  getStats: () => request<Stats>('/api/stats', statsSchema),
  getInvoices: () =>
    request<{ items: InvoiceItem[] }>('/api/invoices', z.object({ items: z.array(invoiceItemSchema) })).then(
      (r) => r.items,
    ),
  getPayable: (id: number) => request<PayableFacts>(`/api/payables/${id}`, payableSchema),
  getDocument: async (id: number): Promise<string> => {
    const res = await fetch(`${API_BASE}/api/payables/${id}/document`)
    if (!res.ok) {
      const bodyJson: unknown = await res.json().catch(() => null)
      const parsed = errorBodySchema.safeParse((bodyJson as { error?: unknown } | null)?.error ?? bodyJson)
      throw new ApiError(
        res.status,
        parsed.success
          ? (parsed.data as ApiErrorBody)
          : { code: 'not_found', layer: 'server', message: 'No payable with this number is on the test registry.', retryable: false },
      )
    }
    return res.text()
  },
  verify: (id: number, mode: 'before_pay' | 'after_pay', doc_sha256?: string) =>
    request<VerifyResponse>(`/api/payables/${id}/verify`, verifySchema, {
      method: 'POST',
      body: JSON.stringify({ mode, ...(doc_sha256 ? { doc_sha256 } : {}) }),
    }),
  createPayable: (asset: 'ccd' | 'eudemo') =>
    request<{ payable_id: number; tx_hash: string; explorer_url: string; fee_testnet_ccd: string; due: string }>(
      '/api/payables',
      z.object({
        payable_id: z.number(),
        tx_hash: z.string(),
        explorer_url: z.string(),
        fee_testnet_ccd: z.string(),
        due: z.string(),
      }),
      { method: 'POST', body: JSON.stringify({ asset }) },
    ),
  pay: (id: number, rail: 'ccd' | 'eudemo', doc_sha256?: string) =>
    request<PayJob>(
      `/api/payables/${id}/pay`,
      z.object({ job_id: z.string(), payable_id: z.number(), rail: z.enum(['ccd', 'eudemo']), steps: z.array(z.string()) }),
      { method: 'POST', body: JSON.stringify({ rail, ...(doc_sha256 ? { doc_sha256 } : {}) }) },
    ),
  getJob: (jobId: string) => request<JobSnapshot>(`/api/jobs/${jobId}`, jobSchema),
  getTxStatus: (hash: string) =>
    request<{ tx_hash: string; status: string; reject?: unknown; fee_testnet_ccd: string; explorer_url: string }>(
      `/api/tx/${hash}/status`,
      z.object({
        tx_hash: z.string(),
        status: z.string(),
        reject: z.unknown(),
        fee_testnet_ccd: z.string(),
        explorer_url: z.string(),
      }),
    ),
  cosignerDryRun: (payable_id: number, to: string, amount: string, memo: string) =>
    request<{ decision: string; reason: string; plain: string; tx_sent: boolean }>(
      '/api/cosigner/dry-run',
      z.object({ decision: z.string(), reason: z.string(), plain: z.string(), tx_sent: z.boolean() }),
      { method: 'POST', body: JSON.stringify({ payable_id, to, amount, memo }) },
    ),
  attack: (kind: string, payable_id: number, mode?: 'send_to_chain' | 'precheck_only') =>
    request<AttackResult>(
      `/api/attacks/${kind}`,
      attackSchema,
      { method: 'POST', body: JSON.stringify({ payable_id, ...(mode ? { mode } : {}) }) },
    ),
  getReceipt: (id: number) => request<Receipt>(`/api/receipts/${id}`, receiptSchema),
  getRecorded: (id: number) => request<RecordedRun>(`/api/recorded/${id}`, recordedSchema),
  getJudgeFiles: () =>
    request<{ files: JudgeFile[] }>('/api/judges/files', judgeFilesSchema).then((r) => r.files),
}
