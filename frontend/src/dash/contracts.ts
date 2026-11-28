// API contracts for the /app dashboard (R0–R5) and /p/<account>.
// EXISTS = live on payonce-api today. PLANNED = WS1/WS3 implement exactly this shape
// (copied into payonce-private HANDOFF_V12). The UI treats a 404 from a PLANNED route
// as "not shipped yet" and says so; it never fakes a result.
import { walletApi, WalletApiError } from '../wallet/api'

export type Verdict = 'MATCH' | 'CLOSE_MATCH' | 'NO_MATCH' | 'UNVERIFIED'

/** EXISTS: GET /api/check-payee?seller=&payee=&legal_name= (alias of /api/vop/check). */
export interface CheckPayee {
  verdict: Verdict
  payable: boolean
  verified_name: string | null
  identity_kind: 'person' | 'business' | null
  standin: boolean
  reasons: string[]
  checks: { id: string; ok: boolean; detail: string }[]
  subject: { contract: string; seller: string; payee: string; invoice_name: string | null; book: { status: string }; proof_anchor: string | null }
  evidence_hash: string
  checked_at: string
}

/** EXISTS: GET /api/wallet/payee-proof/:account */
export interface PayeeProof {
  account: string
  kind: 'person' | 'business'
  name: string
  version: 'v1' | 'v0'
  vra_tx: string | null
  vaa_tx: string | null
  verified_at: string
  issuer: string | null
}

/** EXISTS: GET /api/relay/config */
export interface RelayConfig {
  sponsor: string
  contract: { index: string; subindex: string; name: string }
  entrypoints: string[]
  limits: { max_contract_energy: string; expiry_secs: [number, number]; per_sender_per_minute: number }
}

/** EXISTS: POST /api/relay/prepare { sender, entrypoint, parameter: hex, amount_micro_ccd? } -> sponsor-first transaction. */
export interface PreparedSponsored {
  mode: 'sponsor-first'
  transaction: unknown
  sender: string
  sponsor: string
  fee_paid_by: string
  expires_at: string
  schema: string | null
}

/** PLANNED (WS1): POST /api/payee/propose { account } -> the demo seller proposes the visitor as payee.
    The visitor then signs accept_payee { seller, version, proof_anchor } through /api/relay/prepare. */
export interface ProposedPayee {
  seller: string
  version: number
  /** hex, 32 bytes: sha256 of the stored name proof (see api/src/payee-proof.mjs) */
  proof_anchor: string
  tx_hash: string
}

/** PLANNED (WS1): GET /api/payee/:account -> the visitor's payee-book state on the demo book. */
export interface PayeeStatus {
  account: string
  seller: string
  status: 'NotBound' | 'Proposed' | 'Bound'
  version: number
  /** demo book: 90 s; production 24 h+, set at init */
  hold_secs: number
  hold_ends_at: string | null
  link: string
}

/** PLANNED (WS3): POST /api/invoices/parse { text } */
export interface ParsedInvoice {
  payee_name: string
  account: string
  amount_ccd: string
  reference: string | null
}

/** PLANNED (WS1): POST /api/getpaid { payee, invoice } -> { job_id }; GET /api/getpaid/:job -> GetPaidJob.
    The AP agent pays the visitor from the labelled reference payer after check_payee says MATCH. */
export type GetPaidStage = 'checking' | 'hold' | 'paying' | 'paid' | 'refused' | 'failed'
export interface GetPaidJob {
  job_id: string
  stage: GetPaidStage
  check: CheckPayee | null
  hold_ends_at: string | null
  pay_tx: string | null
  amount_display: string
  payer_label: string
  error: string | null
}

/** PLANNED (WS1): POST /api/getpaid/:job/redirect { to } -> the agent is told to pay another account. */
export interface RedirectResult {
  check: CheckPayee
  /** present when the agent was forced to submit and the chain refused (codes -28..-36) */
  refusal: { code: number; name: string; tx_hash: string } | null
}

/** PLANNED (WS3): GET /api/x402/sellers -> live x402 services run by other teams. */
export interface X402Seller {
  id: string
  name: string
  team: string
  url: string
  price_display: string
  pay_to: string
  needs_age: boolean
}

/** PLANNED (WS1): GET /api/p/:account/pay-tx?payer=&amount_micro= -> the exact pay transaction for the payer's wallet. */
export interface PayLinkTx {
  transaction: import('../wallet/types').UpdateTx
  check: CheckPayee
}

/** PLANNED (WS1): GET /api/record/:account */
export interface RecordItem {
  at: string
  role: 'received' | 'paid' | 'refused'
  counterparty: string
  amount_display: string
  verdict: Verdict
  tx_hash: string
}

export class NotShipped extends Error {
  constructor(public route: string) { super(`${route} is not live yet.`) }
}

async function planned<T>(route: string, path: string, init?: Parameters<typeof walletApi>[1]): Promise<T> {
  try {
    return await walletApi<T>(path, init)
  } catch (e) {
    if (e instanceof WalletApiError && (e.status === 404 || e.code === 'not_found')) throw new NotShipped(route)
    throw e
  }
}

const q = encodeURIComponent

export const dashApi = {
  // EXISTS
  checkPayee: (seller: string, payee: string, name: string) =>
    walletApi<CheckPayee>(`/api/check-payee?seller=${q(seller)}&payee=${q(payee)}&legal_name=${q(name)}`),
  payeeProof: (account: string) => walletApi<{ account: string; proof: PayeeProof | null }>(`/api/wallet/payee-proof/${q(account)}`),
  relayConfig: () => walletApi<RelayConfig>('/api/relay/config'),
  prepare: (sender: string, entrypoint: string, parameterHex: string, amountMicro?: string) =>
    walletApi<PreparedSponsored>('/api/relay/prepare', { method: 'POST', body: { sender, entrypoint, parameter: parameterHex, ...(amountMicro ? { amount_micro_ccd: amountMicro } : {}) } }),
  // PLANNED
  propose: (account: string) => planned<ProposedPayee>('POST /api/payee/propose', '/api/payee/propose', { method: 'POST', body: { account } }),
  payeeStatus: (account: string) => planned<PayeeStatus>('GET /api/payee/:account', `/api/payee/${q(account)}`),
  parseInvoice: (text: string) => planned<ParsedInvoice>('POST /api/invoices/parse', '/api/invoices/parse', { method: 'POST', body: { text } }),
  startGetPaid: (payee: string, invoice: ParsedInvoice | null) =>
    planned<{ job_id: string }>('POST /api/getpaid', '/api/getpaid', { method: 'POST', body: { payee, invoice } }),
  getPaidJob: (job: string) => planned<GetPaidJob>('GET /api/getpaid/:job', `/api/getpaid/${q(job)}`),
  redirect: (job: string, to: string) =>
    planned<RedirectResult>('POST /api/getpaid/:job/redirect', `/api/getpaid/${q(job)}/redirect`, { method: 'POST', body: { to } }),
  x402Sellers: () => planned<{ sellers: X402Seller[] }>('GET /api/x402/sellers', '/api/x402/sellers'),
  payLinkTx: (payee: string, payer: string, amountMicro: string) =>
    planned<PayLinkTx>('GET /api/p/:account/pay-tx', `/api/p/${q(payee)}/pay-tx?payer=${q(payer)}&amount_micro=${q(amountMicro)}`),
  record: (account: string) => planned<{ items: RecordItem[] }>('GET /api/record/:account', `/api/record/${q(account)}`),
}

/** Bank wording for the four outcomes (EU VoP, Reg 2024/886). */
export const VERDICT_TEXT: Record<Verdict, { word: string; tone: 'ok' | 'warn' | 'bad'; agent: string }> = {
  MATCH: { word: 'Match', tone: 'ok', agent: 'Pays once' },
  CLOSE_MATCH: { word: 'Close match', tone: 'warn', agent: 'Asks you first' },
  NO_MATCH: { word: 'No match', tone: 'bad', agent: 'Pays nothing' },
  UNVERIFIED: { word: 'Not possible', tone: 'warn', agent: 'Asks you first' },
}
