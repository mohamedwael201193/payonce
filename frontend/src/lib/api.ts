// Typed API client for the P3 §16 contract. JSON only. No endpoint returns
// a key, a seed or a .env value. Reads and submissions retry 1s / 2s / 4s
// (three tries, §7.5) on node_busy / chain_unreachable / HTTP 429.
import { z } from 'zod'
import type {
  AgeProofHealth,
  AgeProofPolicyDecision,
  AgeProofVerifyResult,
  ApiConfig,
  ApiErrorBody,
  AttackResult,
  Health,
  InvoiceItem,
  InvoicePage,
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

export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

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
  sellers: z
    .array(
      z.object({
        seller: z.string(),
        label: z.string(),
        agent_token: z.number(),
        badge: z.string(),
        badge_url: z.string(),
        agent_card_url: z.string(),
      }),
    )
    .optional(),
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
  payer: z.object({ status: z.enum(['ok', 'low', 'empty']), refilling: z.boolean().optional(), reason: z.string().nullable().optional() }),
  fee_guard: z
    .object({
      enabled: z.boolean(),
      refilling: z.boolean(),
      last_refill_at: z.string().nullable().optional(),
      last_refill_tx: z.string().nullable().optional(),
      refills_24h: z.number().optional(),
    })
    .optional(),
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
  voided_total: z.number().optional(),
  reserved_total: z.number().optional(),
  sources: z.record(z.object({ kind: z.string() }).passthrough()).optional(),
  scan_id: z.string().optional(),
  complete: z.boolean().optional(),
  generated_at: z.string().optional(),
  by_kind: z
    .object({
      demo: z.object({ total: z.number(), paid: z.number() }),
      matrix: z.object({ total: z.number(), paid: z.number() }),
      lab: z.object({ total: z.number(), paid: z.number() }),
      test_runs: z.object({ total: z.number(), paid: z.number() }),
      rule: z.string().optional(),
    })
    .optional(),
})

const invoiceItemSchema = z.object({
  payable_id: z.number(),
  seller: z.string(),
  asset: z.enum(['ccd', 'eudemo']),
  amount_display: z.string(),
  due: z.string(),
  // The live API returns "Paid"/"Unpaid" (capitalized); the dev stub and
  // every consumer in this app use lowercase 'paid'/'unpaid'. Normalize at
  // the parse boundary so the console tabs, row labels, receipt checker
  // and rail links all see the same values against either source.
  status: z.string().transform((s) => s.toLowerCase()),
  label: z.string(),
  kind: z.enum(['demo', 'matrix', 'lab']).optional(),
})

const invoicePageSchema = z.object({
  items: z.array(invoiceItemSchema),
  scan_id: z.string().optional(),
  complete: z.boolean().optional(),
  generated_at: z.string().optional(),
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
    // Fix-back-8 MF-1: the API reports Voided as its own kind now
    // (api/src/server.mjs payableFacts); the frontend must parse it
    // instead of rejecting the facts body as malformed.
    z.object({ kind: z.literal('voided') }),
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
  // The seller that built this receipt (fix-back §4.6: ReceiptPage
  // renders THIS, never the URL). Optional: receipts stored by the pay
  // job path predate the field.
  seller: z.string().optional(),
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
  seller: z.string().nullable().optional(),
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
  seller: z.string().optional(),
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

// ---- Age proof (G8) ----
// The policy-check 403 and the verify 400 are meaningful RESULTS, not
// errors, so these helpers use raw fetch (no retry, no error-envelope
// mapping) and return the status alongside the parsed body.
const ageProofHealthSchema = z.object({
  service: z.string(),
  prover_available: z.boolean(),
  prover: z.object({
    service: z.string(),
    network: z.string(),
    attributes_held: z.array(z.string()),
    issuer_did: z.string().nullable(),
    allow_list: z.array(z.string()),
    refuses: z.array(z.string()),
  }),
  anchored_run: z.object({
    vra: z.string(),
    vaa: z.string(),
    record_sha256: z.string(),
    statements: z.array(z.string()),
  }),
  proven_rejections: z.array(z.string()),
  checked_at: z.string(),
})

const ageProofPolicySchema = z.object({
  allowed: z.boolean(),
  rule: z.string(),
  reason: z.string(),
})

const ageProofVerifySchema = z.object({
  valid: z.boolean(),
  statements: z.array(z.string()).optional(),
  filed_for_payable: z.number().nullable().optional(),
  holder: z.string().nullable().optional(),
  binding: z.string().optional(),
  verified_at: z.string().optional(),
  verifier_status: z.number().optional(),
  reason: z.string().optional(),
})

const ageProofVerifyPresentationSchema = z.object({
  valid: z.boolean(),
  filed_for_payable: z.number().nullable().optional(),
  verified_at: z.string().optional(),
  verifier_status: z.number().optional(),
})

async function rawJson(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  let res: Response
  try {
    res = await timedFetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    throw unreachable('The testnet is not answering. Showing the last verified data.')
  }
  return { status: res.status, body: await res.json().catch(() => null) }
}

function ageProofError(status: number, body: unknown): ApiError {
  const parsed = errorBodySchema.safeParse((body as { error?: unknown } | null)?.error ?? body)
  return new ApiError(
    status,
    parsed.success
      ? (parsed.data as ApiErrorBody)
      : { code: 'internal', layer: 'server', message: 'Something went wrong on our side.', retryable: false },
  )
}

export const ageProofApi = {
  health: async (): Promise<AgeProofHealth> => {
    const { status, body } = await rawJson('/api/age-proof/health')
    if (status !== 200) throw ageProofError(status, body)
    // 200 with prover_available:false is the quiet "not provisioned" status: same error the page already handles.
    if ((body as { prover_available?: boolean } | null)?.prover_available === false) throw ageProofError(503, body)
    const parsed = ageProofHealthSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(status, {
        code: 'internal',
        layer: 'server',
        message: 'Something went wrong on our side.',
        retryable: false,
      })
    }
    return parsed.data
  },
  policyCheck: async (request: unknown): Promise<{ status: number; decision: AgeProofPolicyDecision }> => {
    const { status, body } = await rawJson('/api/age-proof/policy-check', {
      method: 'POST',
      body: JSON.stringify({ request }),
    })
    if (status !== 200 && status !== 403) throw ageProofError(status, body)
    const parsed = ageProofPolicySchema.safeParse(body)
    if (!parsed.success) throw ageProofError(status, body)
    return { status, decision: parsed.data }
  },
  verify: async (
    request: unknown,
    payableId?: number,
    payer?: string,
  ): Promise<{ status: number; result: AgeProofVerifyResult }> => {
    // M3 fix-back: the payable id AND the payer both travel with the
    // request — without them the API verifies but files nothing, so the
    // pay-flow gate can never open. Either may be omitted for a
    // verify-only call (no filing).
    const { status, body } = await rawJson('/api/age-proof/verify', {
      method: 'POST',
      body: JSON.stringify({
        request,
        ...(payableId ? { payable_id: payableId } : {}),
        ...(payer ? { payer } : {}),
      }),
    })
    if (status !== 200 && status !== 400 && status !== 403) throw ageProofError(status, body)
    const parsed = ageProofVerifySchema.safeParse(body)
    if (!parsed.success) throw ageProofError(status, body)
    return { status, result: parsed.data }
  },
  // The real 18+ check for one invoice (V&A V1): the API anchors the request on chain, the scoped prover
  // builds the presentation, the node verifies it, the holder must be the paying account, and the result
  // is anchored and filed for that invoice for 10 minutes. Two small testnet transactions per run.
  runV1: async (payableId: number): Promise<{ status: number; body: AgeV1Result }> => {
    const { status, body } = await rawJson('/api/age-proof/v1', { method: 'POST', body: JSON.stringify({ payable_id: payableId }) })
    return { status, body: (body ?? {}) as AgeV1Result }
  },
  // F2a: verify-only path for a client-supplied presentation, straight to
  // the official verifier. Nothing is filed, the gate is untouched.
  verifyPresentation: async (
    presentation: unknown,
  ): Promise<{ status: number; result: { valid: boolean; verifier_status?: number } }> => {
    const { status, body } = await rawJson('/api/age-proof/verify-presentation', {
      method: 'POST',
      body: JSON.stringify({ presentation }),
    })
    if (status !== 200 && status !== 400) throw ageProofError(status, body)
    const parsed = ageProofVerifyPresentationSchema.safeParse(body)
    if (!parsed.success) throw ageProofError(status, body)
    return { status, result: parsed.data }
  },
}

export interface AgeV1Result {
  ok?: boolean
  step?: string
  error?: string
  message?: string
  code?: string
  binding?: string
  statements?: string[]
  holder?: string
  payable_id?: number
  vra_tx?: string
  vaa_tx?: string
  valid_for_seconds?: number
}

const RETRYABLE_CODES = new Set(['node_busy', 'chain_unreachable'])
const RETRY_DELAYS_MS = [1000, 2000, 4000]

/** Every fetch carries a timeout: a hung request used to leave every loader
    spinning forever (bug 6, browser test pass 1 — "Loading payables…",
    "Checking the age-proof prover…", "Loading the file list…" never
    resolved). 15 s sits above the live API's slow first load (5–8 s) and
    below any user's patience. A timeout is NOT retried: a hung server will
    not answer a retry either, and three more 15 s waits would only delay
    the error state by a minute. */
export const FETCH_TIMEOUT_MS = 15_000

export function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  let signal: AbortSignal = timeout
  if (init?.signal) {
    if (typeof AbortSignal.any === 'function') {
      // A caller signal (fix-back-9 MF-3: the verification deadline)
      // aborts the fetch as well as the timeout — AbortSignal.any
      // combines them, so either one firing cancels the request instead
      // of leaving it running in the background.
      signal = AbortSignal.any([init.signal, timeout])
    } else {
      // Fix-back-10 MF-3: runtimes WITHOUT AbortSignal.any (jsdom 25 in
      // the test env — AbortSignal.any is undefined there; Node 24 and
      // browsers have it) used to fall back to the bare timeout signal,
      // silently dropping the caller's abort: a verification-deadline
      // abort at 100 ms then took the full 15 s fetch timeout instead
      // of cancelling the in-flight read. Combine manually with a
      // forwarding AbortController so either source aborts the fetch.
      const controller = new AbortController()
      const caller = init.signal
      if (caller.aborted) controller.abort(caller.reason)
      else if (timeout.aborted) controller.abort(timeout.reason)
      else {
        const onAbort = () => controller.abort(caller.aborted ? caller.reason : timeout.reason)
        caller.addEventListener('abort', onAbort, { once: true })
        timeout.addEventListener('abort', onAbort, { once: true })
      }
      signal = controller.signal
    }
  }
  return fetch(url, { ...init, signal })
}

/** A timeout abort (TimeoutError from AbortSignal.timeout, AbortError from
    a caller-aborted signal) fails fast with the chain_unreachable error the
    UI already renders — it never retries. */
function timedOut(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')
}

function unreachable(message: string): ApiError {
  return new ApiError(0, {
    code: 'chain_unreachable',
    layer: 'server',
    message,
    retryable: true,
  })
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let res: Response
    try {
      res = await timedFetch(`${API_BASE}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      })
    } catch (e) {
      // A timeout fails fast (see FETCH_TIMEOUT_MS): no retry, straight to
      // the error state the UI already renders.
      if (timedOut(e)) throw unreachable('The testnet did not answer in time. Showing the last verified data.')
      // Network failure: retry like a busy node, then surface as chain_unreachable.
      lastErr = e instanceof Error ? e : new Error('Network error')
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      throw unreachable('The testnet is not answering. Showing the last verified data.')
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

function sellerQuery(seller?: string): string {
  return seller ? `?seller=${encodeURIComponent(seller)}` : ''
}

export const api = {
  getConfig: () => request<ApiConfig>('/api/config', configSchema),
  getHealth: () => request<Health>('/api/health', healthSchema),
  getStats: () => request<Stats>('/api/stats', statsSchema),
  /** The listed rows. The array also carries a non-enumerable `scanMeta`
      (scan_id, complete, generated_at) so a caller can tell that stats and
      list describe the same scan; callers that only want rows ignore it. */
  getInvoices: () =>
    request<InvoicePage>('/api/invoices', invoicePageSchema).then((r) => {
      const items: InvoiceItem[] = r.items
      Object.defineProperty(items, 'scanMeta', {
        value: { scan_id: r.scan_id, complete: r.complete, generated_at: r.generated_at },
        enumerable: false,
      })
      return items
    }),
  // Merge (design-merge onto main 86e2596): two call conventions
  // collide on the 2nd parameter -- main seller threading passes a
  // seller string, fix-back-9 per-id verification passes a
  // RequestInit (deadline signal). Both are accepted: a string is
  // the seller, an object is the init. Callers stay unchanged.
  getPayable: (id: number, sellerOrInit?: string | RequestInit, init?: RequestInit) => {
    const seller = typeof sellerOrInit === 'string' ? sellerOrInit : undefined
    const requestInit = typeof sellerOrInit === 'string' ? init : sellerOrInit
    return request<PayableFacts>(
      `/api/payables/${id}${seller ? `?seller=${encodeURIComponent(seller)}` : ''}`,
      payableSchema,
      requestInit,
    )
  },
  getDocument: async (id: number, seller?: string): Promise<string> => {
    let res: Response
    try {
      res = await timedFetch(`${API_BASE}/api/payables/${id}/document${seller ? `?seller=${encodeURIComponent(seller)}` : ''}`)
    } catch (e) {
      if (timedOut(e)) throw unreachable('The testnet did not answer in time.')
      throw unreachable('The testnet is not answering.')
    }
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
  // v9: the key of a payable is (seller, id). The seller travels as
  // ?seller=<address> on every call that names a payable, so a seller-2 row
  // can never read, check or pay seller 1's payable of the same id.
  verify: (id: number, mode: 'before_pay' | 'after_pay', doc_sha256?: string, seller?: string) =>
    request<VerifyResponse>(`/api/payables/${id}/verify${sellerQuery(seller)}`, verifySchema, {
      method: 'POST',
      body: JSON.stringify({ mode, ...(doc_sha256 ? { doc_sha256 } : {}) }),
    }),
  createPayable: (asset: 'ccd' | 'eudemo', seller?: string) =>
    request<{ payable_id: number; tx_hash: string; explorer_url: string; fee_testnet_ccd: string; due: string }>(
      '/api/payables',
      z.object({
        payable_id: z.number(),
        tx_hash: z.string(),
        explorer_url: z.string(),
        fee_testnet_ccd: z.string(),
        due: z.string(),
      }),
      { method: 'POST', body: JSON.stringify({ asset, ...(seller ? { seller } : {}) }) },
    ),
  pay: (id: number, rail: 'ccd' | 'eudemo', doc_sha256?: string, seller?: string) =>
    request<PayJob>(
      `/api/payables/${id}/pay${sellerQuery(seller)}`,
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
  cosignerDryRun: (payable_id: number, to: string, amount: string, memo: string, seller?: string) =>
    request<{ decision: string; reason: string; plain: string; tx_sent: boolean; basis?: string; basis_note?: string }>(
      '/api/cosigner/dry-run',
      z.object({ decision: z.string(), reason: z.string(), plain: z.string(), tx_sent: z.boolean(), basis: z.string().optional(), basis_note: z.string().optional() }),
      { method: 'POST', body: JSON.stringify({ payable_id, to, amount, memo, ...(seller ? { seller } : {}) }) },
    ),
  attack: (kind: string, payable_id: number, mode?: 'send_to_chain' | 'precheck_only', seller?: string) =>
    request<AttackResult>(
      `/api/attacks/${kind}`,
      attackSchema,
      { method: 'POST', body: JSON.stringify({ payable_id, ...(seller ? { seller } : {}), ...(mode ? { mode } : {}) }) },
    ),
  getReceipt: (id: number, seller?: string) =>
    request<Receipt>(`/api/receipts/${id}${seller ? `?seller=${encodeURIComponent(seller)}` : ''}`, receiptSchema),
  getRecorded: (id: number, seller?: string) =>
    request<RecordedRun>(`/api/recorded/${id}${seller ? `?seller=${encodeURIComponent(seller)}` : ''}`, recordedSchema),
  getJudgeFiles: () =>
    request<{ files: JudgeFile[] }>('/api/judges/files', judgeFilesSchema).then((r) => r.files),
}
